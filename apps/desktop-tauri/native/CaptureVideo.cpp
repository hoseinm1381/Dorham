#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Authorization.AppCapabilityAccess.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <cwchar>
#include <memory>
#include <vector>
#include "fullscreen.h"
#include "scaleFrame.h"

using namespace winrt;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using DxgiAccess = ::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess;
using Clock = std::chrono::steady_clock;

struct Handle {
    HANDLE value;
    ~Handle() { if (value) CloseHandle(value); }
};

static uint64_t number(const wchar_t* value) {
    wchar_t* end = nullptr;
    const auto result = std::wcstoull(value, &end, 10);
    return end && !*end && value[0] >= L'0' && value[0] <= L'9' ? result : 0;
}

static bool writeAll(const void* buffer, DWORD length) {
    const auto* bytes = static_cast<const BYTE*>(buffer);
    const auto pipe = GetStdHandle(STD_OUTPUT_HANDLE);
    while (length) {
        DWORD written = 0;
        if (!WriteFile(pipe, bytes, length, &written, nullptr) || !written) return false;
        bytes += written;
        length -= written;
    }
    return true;
}

struct Target {
    bool window;
    uint64_t handle;
    DWORD process;

    bool isPresent() const {
        if (window) {
            DWORD current = 0;
            return GetWindowThreadProcessId(reinterpret_cast<HWND>(handle), &current) && current == process;
        }
        MONITORINFO info{sizeof(info)};
        return GetMonitorInfoW(reinterpret_cast<HMONITOR>(handle), &info);
    }

    GraphicsCaptureItem captureItem() const {
        auto interop = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
        GraphicsCaptureItem item{nullptr};
        if (window) {
            check_hresult(interop->CreateForWindow(reinterpret_cast<HWND>(handle), guid_of<GraphicsCaptureItem>(), put_abi(item)));
        } else {
            check_hresult(interop->CreateForMonitor(reinterpret_cast<HMONITOR>(handle), guid_of<GraphicsCaptureItem>(), put_abi(item)));
        }
        return item;
    }
};

static com_ptr<ID3D11Device> createDevice() {
    com_ptr<ID3D11Device> device;
    check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
        device.put(), nullptr, nullptr));
    return device;
}

class FrameWriter {
    com_ptr<ID3D11Device> device;
    com_ptr<ID3D11DeviceContext> context;
    com_ptr<ID3D11Texture2D> staging;
    com_ptr<ID3D11Texture2D> scaled, input;
    com_ptr<ID3D11RenderTargetView> renderTarget;
    com_ptr<ID3D11ShaderResourceView> inputView;
    com_ptr<ID3D11VertexShader> vertexShader;
    com_ptr<ID3D11PixelShader> pixelShader;
    com_ptr<ID3D11SamplerState> sampler;
    com_ptr<ID3D11Buffer> extent;
    UINT inputWidth{}, inputHeight{}, outputWidth{}, outputHeight{};
    std::vector<uint32_t> pixels;
    UINT maxWidth;
    UINT maxHeight;

public:
    FrameWriter(UINT width, UINT height, com_ptr<ID3D11Device> sharedDevice)
        : device(sharedDevice), maxWidth(width), maxHeight(height) {
        device->GetImmediateContext(context.put());
        check_hresult(device->CreateVertexShader(fullscreen, sizeof(fullscreen), nullptr, vertexShader.put()));
        check_hresult(device->CreatePixelShader(scaleFrame, sizeof(scaleFrame), nullptr, pixelShader.put()));
        D3D11_SAMPLER_DESC sampling{};
        sampling.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sampling.AddressU = sampling.AddressV = sampling.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        sampling.ComparisonFunc = D3D11_COMPARISON_NEVER;
        check_hresult(device->CreateSamplerState(&sampling, sampler.put()));
        D3D11_BUFFER_DESC constants{};
        constants.ByteWidth = 16;
        constants.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        check_hresult(device->CreateBuffer(&constants, nullptr, extent.put()));
    }

    IDirect3DDevice captureDevice() const {
        com_ptr<::IInspectable> inspectable;
        check_hresult(CreateDirect3D11DeviceFromDXGIDevice(device.as<IDXGIDevice>().get(), inspectable.put()));
        return inspectable.as<IDirect3DDevice>();
    }

    bool send(const Direct3D11CaptureFrame& frame, const uint32_t* slot = nullptr) {
        auto access = frame.Surface().as<DxgiAccess>();
        com_ptr<ID3D11Texture2D> source;
        check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), source.put_void()));
        D3D11_TEXTURE2D_DESC desc{};
        source->GetDesc(&desc);
        const auto size = frame.ContentSize();
        if (size.Width <= 0 || size.Height <= 0 ||
            UINT(size.Width) > desc.Width || UINT(size.Height) > desc.Height) return true;

        const auto scale = std::min({1.0, double(maxWidth) / size.Width, double(maxHeight) / size.Height});
        const uint32_t header[]{std::max(1u, UINT(size.Width * scale)), std::max(1u, UINT(size.Height * scale))};
        const auto [width, height] = header;
        if (width != outputWidth || height != outputHeight) {
            D3D11_TEXTURE2D_DESC texture{};
            texture.Width = width;
            texture.Height = height;
            texture.MipLevels = texture.ArraySize = texture.SampleDesc.Count = 1;
            texture.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
            texture.BindFlags = D3D11_BIND_RENDER_TARGET;
            renderTarget = nullptr; scaled = nullptr; staging = nullptr;
            check_hresult(device->CreateTexture2D(&texture, nullptr, scaled.put()));
            check_hresult(device->CreateRenderTargetView(scaled.get(), nullptr, renderTarget.put()));
            texture.BindFlags = 0;
            texture.Usage = D3D11_USAGE_STAGING;
            texture.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            check_hresult(device->CreateTexture2D(&texture, nullptr, staging.put()));
            pixels.resize(size_t(width) * height);
            outputWidth = width; outputHeight = height;
        }
        if (inputWidth != desc.Width || inputHeight != desc.Height) {
            auto texture = desc;
            texture.BindFlags = D3D11_BIND_SHADER_RESOURCE;
            texture.MiscFlags = texture.CPUAccessFlags = 0;
            texture.Usage = D3D11_USAGE_DEFAULT;
            inputView = nullptr; input = nullptr;
            check_hresult(device->CreateTexture2D(&texture, nullptr, input.put()));
            check_hresult(device->CreateShaderResourceView(input.get(), nullptr, inputView.put()));
            inputWidth = desc.Width; inputHeight = desc.Height;
        }
        context->CopyResource(input.get(), source.get());
        const float crop[]{float(size.Width) / desc.Width, float(size.Height) / desc.Height,
            (size.Width - 0.5f) / desc.Width, (size.Height - 0.5f) / desc.Height};
        context->UpdateSubresource(extent.get(), 0, nullptr, crop, 0, 0);
        D3D11_VIEWPORT viewport{0, 0, float(width), float(height), 0, 1};
        context->RSSetViewports(1, &viewport);
        auto* outputView = renderTarget.get();
        context->OMSetRenderTargets(1, &outputView, nullptr);
        context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vertexShader.get(), nullptr, 0);
        context->PSSetShader(pixelShader.get(), nullptr, 0);
        auto* image = inputView.get();
        auto* sampling = sampler.get();
        auto* constants = extent.get();
        context->PSSetShaderResources(0, 1, &image);
        context->PSSetSamplers(0, 1, &sampling);
        context->PSSetConstantBuffers(0, 1, &constants);
        context->Draw(3, 0);
        ID3D11ShaderResourceView* detached = nullptr;
        context->PSSetShaderResources(0, 1, &detached);
        context->OMSetRenderTargets(0, nullptr, nullptr);
        context->CopyResource(staging.get(), scaled.get());
        D3D11_MAPPED_SUBRESOURCE map{};
        check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &map));
        for (UINT y = 0; y < height; ++y) {
            std::memcpy(pixels.data() + size_t(y) * width,
                static_cast<const BYTE*>(map.pData) + size_t(y) * map.RowPitch, size_t(width) * 4);
        }
        context->Unmap(staging.get(), 0);
        return (!slot || writeAll(slot, sizeof(*slot))) &&
            writeAll(header, sizeof(header)) && writeAll(pixels.data(), DWORD(pixels.size() * sizeof(uint32_t)));
    }
};

// Older Windows builds and unpackaged desktop installations can lack the
// borderless WGC capability. Keep window capture scoped to the chosen HWND.
// Cropping the desktop would expose other windows covering it.
class BitmapSurface {
    HDC dc{};
    HBITMAP bitmap{};
    HGDIOBJ original{};
    int width{}, height{};
public:
    void* bits{};
    ~BitmapSurface() {
        if (original) SelectObject(dc, original);
        if (bitmap) DeleteObject(bitmap);
        if (dc) DeleteDC(dc);
    }
    HDC get(HDC reference, int w, int h, bool readable) {
        if (bitmap && w == width && h == height) return dc;
        if (!dc) dc = CreateCompatibleDC(reference);
        if (!dc) return nullptr;
        if (bitmap) {
            SelectObject(dc, original);
            DeleteObject(bitmap);
            bitmap = nullptr;
        }
        BITMAPINFO info{};
        info.bmiHeader = {sizeof(BITMAPINFOHEADER), w, -h, 1, 32, BI_RGB};
        bitmap = readable ? CreateDIBSection(dc, &info, DIB_RGB_COLORS, &bits, nullptr, 0)
                          : CreateCompatibleBitmap(reference, w, h);
        if (!bitmap) return nullptr;
        original = SelectObject(dc, bitmap);
        width = w; height = h;
        return dc;
    }
};

class ClassicCapture {
    BitmapSurface source, output;
public:
    bool send(const Target& target, UINT maxWidth, UINT maxHeight, const uint32_t* slot = nullptr) {
        RECT bounds{};
        HWND window = target.window ? reinterpret_cast<HWND>(target.handle) : nullptr;
        if (window) {
            DWORD affinity{};
            if (!target.isPresent() || (GetWindowDisplayAffinity(window, &affinity) && affinity != WDA_NONE)) return false;
            if (IsIconic(window) || IsHungAppWindow(window)) return true;
            if (!GetWindowRect(window, &bounds)) return false;
        } else {
            MONITORINFO info{sizeof(info)};
            if (!GetMonitorInfoW(reinterpret_cast<HMONITOR>(target.handle), &info)) return false;
            bounds = info.rcMonitor;
        }
        const int w = bounds.right - bounds.left, h = bounds.bottom - bounds.top;
        if (w <= 0 || h <= 0 || int64_t(w) * h > 128LL * 1024 * 1024) return false;
        const double ratio = std::min({1.0, double(maxWidth) / w, double(maxHeight) / h});
        const uint32_t header[]{std::max(1u, UINT(w * ratio)), std::max(1u, UINT(h * ratio))};
        struct DesktopDC {
            HDC value = GetDC(nullptr);
            ~DesktopDC() { if (value) ReleaseDC(nullptr, value); }
        } desktop;
        if (!desktop.value) return false;
        HDC dest = output.get(desktop.value, header[0], header[1], true);
        if (!dest) return false;
        HDC from = desktop.value;
        int x = bounds.left, y = bounds.top;
        if (window) {
            from = source.get(desktop.value, w, h, false);
            if (!from) return false;
            if (!PrintWindow(window, from, PW_RENDERFULLCONTENT)) return false;
            x = y = 0;
        }
        SetStretchBltMode(dest, COLORONCOLOR);
        if (!StretchBlt(dest, 0, 0, header[0], header[1], from, x, y, w, h,
                        window ? SRCCOPY : SRCCOPY | CAPTUREBLT)) return false;
        if (!slot) {
            CURSORINFO cursor{sizeof(cursor)};
            if (GetCursorInfo(&cursor) && (cursor.flags & CURSOR_SHOWING) && PtInRect(&bounds, cursor.ptScreenPos)
                && (!window || GetAncestor(WindowFromPoint(cursor.ptScreenPos), GA_ROOT) == window)) {
                ICONINFO icon{};
                if (GetIconInfo(cursor.hCursor, &icon)) {
                    BITMAP shape{};
                    if (GetObjectW(icon.hbmColor ? icon.hbmColor : icon.hbmMask, sizeof(shape), &shape)) {
                        const int height = icon.hbmColor ? shape.bmHeight : shape.bmHeight / 2;
                        DrawIconEx(dest, int((cursor.ptScreenPos.x - bounds.left - int(icon.xHotspot)) * ratio),
                            int((cursor.ptScreenPos.y - bounds.top - int(icon.yHotspot)) * ratio), cursor.hCursor,
                            std::max(1, int(shape.bmWidth * ratio)), std::max(1, int(height * ratio)), 0, nullptr, DI_NORMAL);
                    }
                    if (icon.hbmColor) DeleteObject(icon.hbmColor);
                    if (icon.hbmMask) DeleteObject(icon.hbmMask);
                }
            }
        }
        GdiFlush();
        return target.isPresent() && (!slot || writeAll(slot, sizeof(*slot))) && writeAll(header, sizeof(header))
            && writeAll(output.bits, header[0] * header[1] * 4);
    }
};

static bool allowBorderless() {
    using winrt::Windows::Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus;
    try {
        return GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless).get()
            == AppCapabilityAccessStatus::Allowed;
    } catch (const hresult_error&) { return false; }
}

static bool configureBorderless(const GraphicsCaptureSession& session) {
    try {
        session.IsBorderRequired(false);
        return !session.IsBorderRequired();
    } catch (const hresult_error&) { return false; }
}

struct Preview {
    Target target;
    GraphicsCaptureItem item;
    winrt::Windows::Graphics::SizeInt32 size;
    Direct3D11CaptureFramePool pool;
    GraphicsCaptureSession session;
    FrameWriter writer;

    Preview(Target source, const IDirect3DDevice& device, const com_ptr<ID3D11Device>& native)
        : target(source), item(source.captureItem()), size(item.Size()),
          pool(Direct3D11CaptureFramePool::CreateFreeThreaded(device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size)),
          session(pool.CreateCaptureSession(item)), writer(192, 108, native) {
        if (!configureBorderless(session)) throw hresult_error(E_ACCESSDENIED);
        try { session.IsCursorCaptureEnabled(false); } catch (const hresult_error&) {}
        try { session.MinUpdateInterval(std::chrono::milliseconds(250)); } catch (const hresult_error&) {}
        session.StartCapture();
    }

    ~Preview() {
        try { session.Close(); } catch (const hresult_error&) {}
        try { pool.Close(); } catch (const hresult_error&) {}
    }

    bool poll(const IDirect3DDevice& device, uint32_t slot) {
        if (target.window && IsIconic(reinterpret_cast<HWND>(target.handle))) return true;
        auto frame = pool.TryGetNextFrame();
        if (!frame) return true;
        const auto content = frame.ContentSize();
        if (content.Width != size.Width || content.Height != size.Height) {
            frame.Close();
            if (content.Width <= 0 || content.Height <= 0) return true;
            pool.Recreate(device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, content);
            size = content;
            return true;
        }
        const auto written = writer.send(frame, &slot);
        frame.Close();
        return written;
    }
};

static int runPreviews(int count, wchar_t** args) {
    constexpr int maxSources = 6;
    const auto parent = number(args[2]);
    if (!parent || parent > MAXDWORD || count < 6 || (count - 3) % 3 || (count - 3) / 3 > maxSources) return 2;
    const Handle owner{OpenProcess(SYNCHRONIZE, FALSE, DWORD(parent))};
    if (!owner.value) return 3;
    init_apartment(apartment_type::multi_threaded);
    com_ptr<ID3D11Device> native;
    IDirect3DDevice device{nullptr};
    if (GraphicsCaptureSession::IsSupported() && allowBorderless()) {
        try {
            native = createDevice();
            com_ptr<::IInspectable> inspectable;
            check_hresult(CreateDirect3D11DeviceFromDXGIDevice(native.as<IDXGIDevice>().get(), inspectable.put()));
            device = inspectable.as<IDirect3DDevice>();
        } catch (const hresult_error&) {}
    }
    std::vector<std::unique_ptr<Preview>> sources((count - 3) / 3);
    std::vector<std::unique_ptr<ClassicCapture>> classic(sources.size());
    std::vector<Target> targets(sources.size());
    for (size_t slot = 0; slot < sources.size(); ++slot) {
        const auto index = 3 + slot * 3;
        const bool window = std::wcscmp(args[index], L"window") == 0;
        const auto handle = number(args[index + 1]), pid = number(args[index + 2]);
        if (!window && std::wcscmp(args[index], L"monitor") != 0) continue;
        if (!handle || pid > MAXDWORD || (window && pid == parent)) continue;
        const Target target{window, handle, DWORD(pid)};
        if (!target.isPresent()) continue;
        targets[slot] = target;
        if (device) {
            try { sources[slot] = std::make_unique<Preview>(target, device, native); }
            catch (const hresult_error&) {}
        }
        if (!sources[slot]) classic[slot] = std::make_unique<ClassicCapture>();
    }
    while (WaitForSingleObject(owner.value, 250) == WAIT_TIMEOUT) {
        bool active = false;
        for (uint32_t slot = 0; slot < sources.size(); ++slot) {
            if (classic[slot]) {
                if (classic[slot]->send(targets[slot], 192, 108, &slot)) active = true;
                else classic[slot].reset();
                continue;
            }
            auto& source = sources[slot];
            if (!source) continue;
            if (!source->target.isPresent()) { source.reset(); continue; }
            try {
                if (!source->poll(device, slot)) return 0;
                active = true;
            } catch (const hresult_error&) { source.reset(); }
        }
        if (!active) break;
    }
    return 0;
}

int wmain(int count, wchar_t** args) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if (count >= 3 && std::wcscmp(args[1], L"previews") == 0) {
        try { return runPreviews(count, args); }
        catch (const hresult_error&) { return 5; }
    }
    if (count != 8) return 2;
    const bool window = std::wcscmp(args[1], L"window") == 0;
    if (!window && std::wcscmp(args[1], L"monitor") != 0) return 2;
    const auto handle = number(args[2]), pid = number(args[3]), parent = number(args[4]);
    const auto width = number(args[5]), height = number(args[6]), fps = number(args[7]);
    if (!handle || !parent || parent > MAXDWORD || pid > MAXDWORD ||
        !width || width > 3840 || !height || height > 2160 || !fps || fps > 60) return 2;
    const Target target{window, handle, DWORD(pid)};
    if (!target.isPresent() || (window && pid == parent)) return 3;
    const Handle owner{OpenProcess(SYNCHRONIZE, FALSE, DWORD(parent))};
    if (!owner.value) return 3;
    const auto interval = std::chrono::microseconds(1000000 / fps);
    auto classicCapture = [&]() {
        ClassicCapture capture;
        auto next = Clock::now();
        while (WaitForSingleObject(owner.value, 0) == WAIT_TIMEOUT && target.isPresent()) {
            if (!capture.send(target, UINT(width), UINT(height))) break;
            const auto now = Clock::now();
            do { next += interval; } while (next <= now);
            auto wait = std::chrono::ceil<std::chrono::milliseconds>(next - now).count();
            if (WaitForSingleObject(owner.value, DWORD(wait)) != WAIT_TIMEOUT) break;
        }
        return 0;
    };
    try {
        init_apartment(apartment_type::multi_threaded);
        if (!GraphicsCaptureSession::IsSupported() || !allowBorderless()) return classicCapture();
        // The event revokers and capture objects are destroyed before the events.
        const Handle available{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
        const Handle closed{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
        if (!available.value || !closed.value) return 4;
        FrameWriter writer{UINT(width), UINT(height), createDevice()};
        const auto device = writer.captureDevice();
        auto item = target.captureItem();
        auto closedEvent = item.Closed(auto_revoke, [event = closed.value](auto&&, auto&&) { SetEvent(event); });
        auto size = item.Size();
        auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
        auto frameEvent = pool.FrameArrived(auto_revoke, [event = available.value](auto&&, auto&&) { SetEvent(event); });
        auto session = pool.CreateCaptureSession(item);
        if (!configureBorderless(session)) return classicCapture();
        try { session.MinUpdateInterval(interval); } catch (const hresult_error&) {}
        if (!target.isPresent()) return 3;
        session.StartCapture();

        const HANDLE events[]{owner.value, closed.value, available.value};
        const auto started = Clock::now();
        auto next = started;
        bool sentFrame = false;
        while (target.isPresent()) {
            const auto signalled = WaitForMultipleObjects(3, events, FALSE, 250);
            if (signalled != WAIT_OBJECT_0 + 2) {
                if (signalled == WAIT_TIMEOUT && (sentFrame || Clock::now() - started < std::chrono::seconds(8))) continue;
                break;
            }
            auto frame = pool.TryGetNextFrame();
            if (!frame) continue;
            const auto now = Clock::now();
            const auto content = frame.ContentSize();
            if (content.Width != size.Width || content.Height != size.Height) {
                frame.Close();
                if (content.Width <= 0 || content.Height <= 0) break;
                pool.Recreate(device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content);
                size = content;
                continue;
            }
            if (now >= next) {
                if (!target.isPresent() || !writer.send(frame)) break;
                sentFrame = true;
                const auto elapsed = now - next;
                next += interval * (elapsed / interval + 1);
            }
            frame.Close();
        }
        frameEvent.revoke();
        closedEvent.revoke();
        session.Close();
        pool.Close();
        return 0;
    } catch (const hresult_error& error) {
        std::fprintf(stderr, "Windows Graphics Capture failed (%08lx)\n", static_cast<unsigned long>(error.code().value));
        return 5;
    } catch (...) {
        return 5;
    }
}
