#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
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
#include <condition_variable>
#include <mutex>
#include <thread>
#include "fullscreen.h"
#include "scaleFrame.h"
#include "packNV12.h"

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
    com_ptr<IDXGIDevice2> queue;
    Handle ready{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
    com_ptr<ID3D11Texture2D> staging;
    com_ptr<ID3D11Texture2D> scaled, input;
    com_ptr<ID3D11RenderTargetView> renderTarget;
    com_ptr<ID3D11ShaderResourceView> inputView;
    com_ptr<ID3D11VertexShader> vertexShader;
    com_ptr<ID3D11PixelShader> pixelShader, nv12Shader;
    bool pending{}, packed{};
    UINT rowBytes{}, rows{};
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
        queue = device.as<IDXGIDevice2>();
        if (!ready.value) throw_last_error();
        check_hresult(device->CreateVertexShader(fullscreen, sizeof(fullscreen), nullptr, vertexShader.put()));
        check_hresult(device->CreatePixelShader(scaleFrame, sizeof(scaleFrame), nullptr, pixelShader.put()));
        D3D11_SAMPLER_DESC sampling{};
        sampling.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        sampling.AddressU = sampling.AddressV = sampling.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
        sampling.ComparisonFunc = D3D11_COMPARISON_NEVER;
        check_hresult(device->CreateSamplerState(&sampling, sampler.put()));
        D3D11_BUFFER_DESC constants{};
        check_hresult(device->CreatePixelShader(packNV12, sizeof(packNV12), nullptr, nv12Shader.put()));
        constants.ByteWidth = 32;
        constants.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
        check_hresult(device->CreateBuffer(&constants, nullptr, extent.put()));
    }

    IDirect3DDevice captureDevice() const {
        com_ptr<::IInspectable> inspectable;
        check_hresult(CreateDirect3D11DeviceFromDXGIDevice(device.as<IDXGIDevice>().get(), inspectable.put()));
        return inspectable.as<IDirect3DDevice>();
    }

    void setLimits(UINT width, UINT height) { maxWidth = width; maxHeight = height; }
    HANDLE readbackEvent() const { return ready.value; }
    bool drain(const uint32_t* slot = nullptr) {
        if (!pending) return true;
        D3D11_MAPPED_SUBRESOURCE map{};
        const auto hr = context->Map(staging.get(), 0, D3D11_MAP_READ,
            slot ? 0 : D3D11_MAP_FLAG_DO_NOT_WAIT, &map);
        if (hr == DXGI_ERROR_WAS_STILL_DRAWING) return true;
        check_hresult(hr);
        for (UINT y = 0; y < rows; ++y)
            std::memcpy(reinterpret_cast<BYTE*>(pixels.data()) + size_t(y) * rowBytes,
                static_cast<const BYTE*>(map.pData) + size_t(y) * map.RowPitch, rowBytes);
        context->Unmap(staging.get(), 0);
        pending = false;
        const uint32_t header[]{outputWidth | (packed ? 0x80000000u : 0), outputHeight};
        return (!slot || writeAll(slot, sizeof(*slot))) && writeAll(header, sizeof(header))
            && writeAll(pixels.data(), rowBytes * rows);
    }

    bool send(const Direct3D11CaptureFrame& frame, const uint32_t* slot = nullptr) {
        if (pending) return true;
        auto access = frame.Surface().as<DxgiAccess>();
        com_ptr<ID3D11Texture2D> source;
        check_hresult(access->GetInterface(__uuidof(ID3D11Texture2D), source.put_void()));
        D3D11_TEXTURE2D_DESC desc{};
        source->GetDesc(&desc);
        const auto size = frame.ContentSize();
        if (size.Width <= 0 || size.Height <= 0 ||
            UINT(size.Width) > desc.Width || UINT(size.Height) > desc.Height) return true;

        const auto scale = std::min({1.0, double(maxWidth) / size.Width, double(maxHeight) / size.Height});
        UINT width = std::max(1u, UINT(size.Width * scale)), height = std::max(1u, UINT(size.Height * scale));
        packed = !slot && width >= 4 && height >= 2;
        if (packed) { width &= ~3u; height &= ~1u; }
        rowBytes = packed ? width : width * 4;
        rows = packed ? height + height / 2 : height;
        if (width != outputWidth || height != outputHeight) {
            D3D11_TEXTURE2D_DESC texture{};
            texture.Width = rowBytes / 4;
            texture.Height = rows;
            texture.MipLevels = texture.ArraySize = texture.SampleDesc.Count = 1;
            texture.Format = packed ? DXGI_FORMAT_R8G8B8A8_UNORM : DXGI_FORMAT_B8G8R8A8_UNORM;
            texture.BindFlags = D3D11_BIND_RENDER_TARGET;
            renderTarget = nullptr; scaled = nullptr; staging = nullptr;
            check_hresult(device->CreateTexture2D(&texture, nullptr, scaled.put()));
            check_hresult(device->CreateRenderTargetView(scaled.get(), nullptr, renderTarget.put()));
            texture.BindFlags = 0;
            texture.Usage = D3D11_USAGE_STAGING;
            texture.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            check_hresult(device->CreateTexture2D(&texture, nullptr, staging.put()));
            pixels.resize(size_t(rowBytes / 4) * rows);
            outputWidth = width; outputHeight = height;
        }
        com_ptr<ID3D11ShaderResourceView> directView;
        if (desc.BindFlags & D3D11_BIND_SHADER_RESOURCE) {
            device->CreateShaderResourceView(source.get(), nullptr, directView.put());
        }
        if (!directView && (inputWidth != desc.Width || inputHeight != desc.Height)) {
            auto texture = desc;
            texture.BindFlags = D3D11_BIND_SHADER_RESOURCE;
            texture.MiscFlags = texture.CPUAccessFlags = 0;
            texture.Usage = D3D11_USAGE_DEFAULT;
            inputView = nullptr; input = nullptr;
            check_hresult(device->CreateTexture2D(&texture, nullptr, input.put()));
            check_hresult(device->CreateShaderResourceView(input.get(), nullptr, inputView.put()));
            inputWidth = desc.Width; inputHeight = desc.Height;
        }
        if (!directView) context->CopyResource(input.get(), source.get());
        const float crop[]{float(size.Width) / desc.Width, float(size.Height) / desc.Height,
            (size.Width - 0.5f) / desc.Width, (size.Height - 0.5f) / desc.Height, float(width), float(height), 0, 0};
        context->UpdateSubresource(extent.get(), 0, nullptr, crop, 0, 0);
        D3D11_VIEWPORT viewport{0, 0, float(rowBytes / 4), float(rows), 0, 1};
        context->RSSetViewports(1, &viewport);
        auto* outputView = renderTarget.get();
        context->OMSetRenderTargets(1, &outputView, nullptr);
        context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vertexShader.get(), nullptr, 0);
        context->PSSetShader(packed ? nv12Shader.get() : pixelShader.get(), nullptr, 0);
        auto* image = directView ? directView.get() : inputView.get();
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
        pending = true;
        if (!slot) check_hresult(queue->EnqueueSetEvent(ready.value));
        return slot ? drain(slot) : true;
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

// PrintWindow can block inside another application's paint handler. One worker
// owns the in-flight paint. The capture loop polls it and never queues a second.
class WindowPaint {
    struct State {
        std::mutex mutex;
        std::condition_variable wake;
        BitmapSurface surface;
        Target target{};
        HDC dc{};
        bool requested{}, ready{}, success{}, stop{};
        int width{}, height{};
    };
    std::shared_ptr<State> state = std::make_shared<State>();
public:
    WindowPaint() {
        std::thread([s = state] {
            std::unique_lock lock(s->mutex);
            for (;;) {
                s->wake.wait(lock, [&] { return s->requested || s->stop; });
                if (s->stop) return;
                auto target = s->target;
                auto dc = s->dc;
                lock.unlock();
                const HWND window = reinterpret_cast<HWND>(target.handle);
                bool ok = target.isPresent() && PrintWindow(window, dc, IsIconic(window) ? 0 : PW_RENDERFULLCONTENT);
                GdiFlush();
                lock.lock();
                s->success = ok;
                s->requested = false;
                s->ready = true;
            }
        }).detach();
    }
    ~WindowPaint() {
        std::lock_guard lock(state->mutex);
        state->stop = true;
        state->wake.notify_one();
    }
    HDC poll(Target target, HDC reference, int width, int height) {
        std::lock_guard lock(state->mutex);
        if (state->requested) return nullptr;
        if (state->ready) {
            state->ready = false;
            if (state->success && state->width == width && state->height == height) return state->dc;
        }
        state->dc = state->surface.get(reference, width, height, false);
        if (!state->dc) return nullptr;
        if (state->width != width || state->height != height || IsIconic(reinterpret_cast<HWND>(target.handle))) {
            PatBlt(state->dc, 0, 0, width, height, BLACKNESS);
            GdiFlush();
        }
        state->width = width; state->height = height; state->target = target;
        state->requested = true;
        state->wake.notify_one();
        return nullptr;
    }
};

class ClassicCapture {
    BitmapSurface output;
    std::vector<BYTE> nv12;
    std::unique_ptr<WindowPaint> painter;
    bool sentMinimizedFrame{};
    Clock::time_point nextStatus{};
    // Limited-range BT.709, identical plane layout to the GPU shader.
    bool writeCompact(UINT width, UINT height) {
        const size_t area = size_t(width) * height;
        nv12.resize(area + area / 2);
        const auto* source = static_cast<const BYTE*>(output.bits);
        for (UINT y = 0; y < height; y += 2) {
            auto* uv = nv12.data() + area + size_t(y / 2) * width;
            for (UINT x = 0; x < width; x += 2) {
                int r = 0, g = 0, b = 0;
                for (UINT dy = 0; dy < 2; ++dy) {
                    const size_t i = size_t(y + dy) * width + x;
                    for (UINT dx = 0; dx < 2; ++dx) {
                        const auto* p = source + (i + dx) * 4;
                        nv12[i + dx] = BYTE(16 + ((47 * p[2] + 157 * p[1] + 16 * p[0] + 128) >> 8));
                        r += p[2]; g += p[1]; b += p[0];
                    }
                }
                uv[x] = BYTE(128 + ((112 * b - 86 * g - 26 * r + 512) >> 10));
                uv[x + 1] = BYTE(128 + ((112 * r - 102 * g - 10 * b + 512) >> 10));
            }
        }
        const uint32_t header[]{width | 0x80000000u, height};
        return writeAll(header, sizeof(header)) && writeAll(nv12.data(), DWORD(nv12.size()));
    }
public:
    void resetMinimized() { sentMinimizedFrame = false; nextStatus = {}; }
    bool send(const Target& target, UINT maxWidth, UINT maxHeight, const uint32_t* slot = nullptr) {
        RECT bounds{};
        HWND window = target.window ? reinterpret_cast<HWND>(target.handle) : nullptr;
        if (window) {
            DWORD affinity{};
            if (!target.isPresent() || (GetWindowDisplayAffinity(window, &affinity) && affinity != WDA_NONE)) return false;
            if (IsHungAppWindow(window)) return true;
            if (IsIconic(window)) {
                WINDOWPLACEMENT placement{sizeof(placement)};
                if (!GetWindowPlacement(window, &placement)) return false;
                bounds = placement.rcNormalPosition;
            } else if (!GetWindowRect(window, &bounds)) return false;
        } else {
            MONITORINFO info{sizeof(info)};
            if (!GetMonitorInfoW(reinterpret_cast<HMONITOR>(target.handle), &info)) return false;
            bounds = info.rcMonitor;
        }
        const int w = bounds.right - bounds.left, h = bounds.bottom - bounds.top;
        if (w <= 0 || h <= 0 || int64_t(w) * h > 128LL * 1024 * 1024) return false;
        const double ratio = std::min({1.0, double(maxWidth) / w, double(maxHeight) / h});
        uint32_t header[]{std::max(1u, UINT(w * ratio)), std::max(1u, UINT(h * ratio))};
        const bool compact = !slot && header[0] >= 4 && header[1] >= 2;
        if (compact) { header[0] &= ~3u; header[1] &= ~1u; }
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
            if (!painter) painter = std::make_unique<WindowPaint>();
            from = painter->poll(target, desktop.value, w, h);
            if (!from) {
                if (slot || !IsIconic(window) || sentMinimizedFrame || Clock::now() < nextStatus) return true;
                PatBlt(dest, 0, 0, header[0], header[1], BLACKNESS);
            }
            x = y = 0;
        }
        SetStretchBltMode(dest, COLORONCOLOR);
        if (from && !StretchBlt(dest, 0, 0, header[0], header[1], from, x, y, w, h,
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
        // The source bitmap is no longer in use. Begin its next repaint while
        // the completed output is being delivered.
        if (window && from) painter->poll(target, desktop.value, w, h);
        if (!slot && window && IsIconic(window)) {
            // Some applications discard their client surface while minimized.
            // Keep the share alive until the window supplies content again.
            const auto pixels = static_cast<const uint32_t*>(output.bits);
            const size_t count = size_t(header[0]) * header[1];
            const bool empty = std::none_of(pixels, pixels + count,
                [](uint32_t pixel) { return (pixel & 0xffffff) != 0; });
            if (empty) {
                if (sentMinimizedFrame || Clock::now() < nextStatus) return true;
                SetBkMode(dest, TRANSPARENT);
                SetTextColor(dest, RGB(220, 220, 220));
                RECT area{0, 0, LONG(header[0]), LONG(header[1])};
                DrawTextW(dest, L"Window minimized", -1, &area, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
                GdiFlush();
                nextStatus = Clock::now() + std::chrono::seconds(1);
            } else sentMinimizedFrame = true;
        } else sentMinimizedFrame = false;
        if (!target.isPresent()) return false;
        if (compact) return writeCompact(header[0], header[1]);
        return (!slot || writeAll(slot, sizeof(*slot))) && writeAll(header, sizeof(header))
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
    auto width = number(args[5]), height = number(args[6]), fps = number(args[7]);
    if (!handle || !parent || parent > MAXDWORD || pid > MAXDWORD ||
        !width || width > 3840 || !height || height > 2160 || !fps || fps > 60) return 2;
    const Target target{window, handle, DWORD(pid)};
    if (!target.isPresent() || (window && pid == parent)) return 3;
    const Handle owner{OpenProcess(SYNCHRONIZE, FALSE, DWORD(parent))};
    if (!owner.value) return 3;
    auto interval = std::chrono::microseconds(1000000 / fps);
    auto updateSettings = [&]() {
        const auto control = GetStdHandle(STD_INPUT_HANDLE);
        DWORD available = 0, count = 0;
        uint32_t fields[3];
        bool changed = false;
        while (PeekNamedPipe(control, nullptr, 0, nullptr, &available, nullptr) && available >= sizeof(fields)) {
            if (!ReadFile(control, fields, sizeof(fields), &count, nullptr) || count != sizeof(fields)) break;
            if (!fields[0] || fields[0] > 3840 || !fields[1] || fields[1] > 2160 || !fields[2] || fields[2] > 60) continue;
            width = fields[0]; height = fields[1]; fps = fields[2];
            interval = std::chrono::microseconds(1000000 / fps);
            changed = true;
        }
        return changed;
    };
    auto minimized = [&]() { return window && IsIconic(reinterpret_cast<HWND>(handle)); };
    ClassicCapture background;
    auto captureMinimized = [&]() {
        background.resetMinimized();
        while (minimized() && target.isPresent()) {
            updateSettings();
            if (!background.send(target, UINT(width), UINT(height)) ||
                WaitForSingleObject(owner.value, 125) != WAIT_TIMEOUT) return false;
        }
        return target.isPresent();
    };
    auto classicCapture = [&]() {
        ClassicCapture capture;
        auto next = Clock::now();
        while (WaitForSingleObject(owner.value, 0) == WAIT_TIMEOUT && target.isPresent()) {
            updateSettings();
            if (!capture.send(target, UINT(width), UINT(height))) break;
            const auto now = Clock::now();
            const auto period = minimized() ? std::max(interval, std::chrono::microseconds(125000)) : interval;
            do { next += period; } while (next <= now);
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
        if (size.Width <= 0 || size.Height <= 0) {
            if (!minimized() || !captureMinimized()) return 0;
            size = item.Size();
            if (size.Width <= 0 || size.Height <= 0) return classicCapture();
        }
        auto pool = Direct3D11CaptureFramePool::CreateFreeThreaded(device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
        auto frameEvent = pool.FrameArrived(auto_revoke, [event = available.value](auto&&, auto&&) { SetEvent(event); });
        auto session = pool.CreateCaptureSession(item);
        if (!configureBorderless(session)) return classicCapture();
        try { session.MinUpdateInterval(interval); } catch (const hresult_error&) {}
        if (!target.isPresent()) return 3;
        session.StartCapture();

        const HANDLE events[]{owner.value, closed.value, available.value, writer.readbackEvent()};
        const auto started = Clock::now();
        auto next = started;
        auto lastSurface = started;
        auto nextBackground = started;
        bool wasMinimized = false;
        bool sentFrame = false;
        while (target.isPresent()) {
            const auto tick = Clock::now();
            const bool iconic = minimized();
            if (iconic != wasMinimized) {
                background.resetMinimized();
                lastSurface = next = tick;
                wasMinimized = iconic;
            }
            if (iconic && tick >= nextBackground && tick - lastSurface >= std::chrono::milliseconds(350)) {
                if (!background.send(target, UINT(width), UINT(height))) break;
                nextBackground = tick + std::chrono::milliseconds(125);
            }
            if (updateSettings()) {
                writer.setLimits(UINT(width), UINT(height));
                try { session.MinUpdateInterval(interval); } catch (const hresult_error&) {}
                next = Clock::now();
            }
            if (!writer.drain()) break;
            const auto signalled = WaitForMultipleObjects(4, events, FALSE, 125);
            if (signalled == WAIT_OBJECT_0 + 3) continue;
            if (signalled != WAIT_OBJECT_0 + 2) {
                if (signalled == WAIT_TIMEOUT && (iconic || sentFrame || Clock::now() - lastSurface < std::chrono::seconds(8))) continue;
                break;
            }
            auto frame = pool.TryGetNextFrame();
            if (!frame) continue;
            const auto now = Clock::now();
            const auto content = frame.ContentSize();
            // Windows may expose only an icon-sized surface while minimized.
            if (iconic && (content.Width < 160 || content.Height < 48)) {
                frame.Close();
                continue;
            }
            if (content.Width != size.Width || content.Height != size.Height) {
                frame.Close();
                if (content.Width <= 0 || content.Height <= 0) continue;
                pool.Recreate(device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content);
                size = content;
                continue;
            }
            // Allow ordinary arrival jitter without discarding a whole frame.
            const auto due = now + interval / 10;
            if (due >= next) {
                if (!target.isPresent() || !writer.send(frame)) break;
                lastSurface = now;
                sentFrame = true;
                const auto elapsed = due - next;
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
        if (minimized() && target.isPresent()) return classicCapture();
        std::fprintf(stderr, "Windows Graphics Capture failed (%08lx)\n", static_cast<unsigned long>(error.code().value));
        return 5;
    } catch (...) {
        return 5;
    }
}
