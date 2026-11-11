#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cwchar>
#include <memory>
#include <vector>

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
    D3D11_TEXTURE2D_DESC stagingDesc{};
    std::vector<uint32_t> pixels;
    UINT maxWidth;
    UINT maxHeight;

public:
    FrameWriter(UINT width, UINT height, com_ptr<ID3D11Device> sharedDevice)
        : device(sharedDevice), maxWidth(width), maxHeight(height) {
        device->GetImmediateContext(context.put());
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

        if (!staging || stagingDesc.Width != desc.Width || stagingDesc.Height != desc.Height) {
            staging = nullptr;
            stagingDesc = desc;
            stagingDesc.BindFlags = 0;
            stagingDesc.MiscFlags = 0;
            stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            stagingDesc.Usage = D3D11_USAGE_STAGING;
            check_hresult(device->CreateTexture2D(&stagingDesc, nullptr, staging.put()));
        }

        const auto scale = std::min({1.0, double(maxWidth) / size.Width, double(maxHeight) / size.Height});
        const uint32_t header[]{std::max(1u, UINT(size.Width * scale)), std::max(1u, UINT(size.Height * scale))};
        const auto [width, height] = header;
        pixels.resize(size_t(width) * height);
        context->CopyResource(staging.get(), source.get());
        D3D11_MAPPED_SUBRESOURCE map{};
        check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &map));
        for (UINT y = 0; y < height; ++y) {
            const auto* row = reinterpret_cast<const uint32_t*>(
                static_cast<const BYTE*>(map.pData) + size_t(y * size.Height / height) * map.RowPitch);
            auto* output = pixels.data() + size_t(y) * width;
            for (UINT x = 0; x < width; ++x) {
                output[x] = row[x * size.Width / width] | 0xff000000;
            }
        }
        context->Unmap(staging.get(), 0);
        return (!slot || writeAll(slot, sizeof(*slot))) &&
            writeAll(header, sizeof(header)) && writeAll(pixels.data(), DWORD(pixels.size() * sizeof(uint32_t)));
    }
};

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
    if (!GraphicsCaptureSession::IsSupported()) return 4;
    const auto native = createDevice();
    com_ptr<::IInspectable> inspectable;
    check_hresult(CreateDirect3D11DeviceFromDXGIDevice(native.as<IDXGIDevice>().get(), inspectable.put()));
    const auto device = inspectable.as<IDirect3DDevice>();
    std::vector<std::unique_ptr<Preview>> sources((count - 3) / 3);
    for (size_t slot = 0; slot < sources.size(); ++slot) {
        const auto index = 3 + slot * 3;
        const bool window = std::wcscmp(args[index], L"window") == 0;
        const auto handle = number(args[index + 1]), pid = number(args[index + 2]);
        if (!window && std::wcscmp(args[index], L"monitor") != 0) continue;
        if (!handle || pid > MAXDWORD || (window && pid == parent)) continue;
        const Target target{window, handle, DWORD(pid)};
        if (!target.isPresent()) continue;
        try { sources[slot] = std::make_unique<Preview>(target, device, native); }
        catch (const hresult_error&) {}
    }
    while (WaitForSingleObject(owner.value, 250) == WAIT_TIMEOUT) {
        bool active = false;
        for (uint32_t slot = 0; slot < sources.size(); ++slot) {
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
    try {
        init_apartment(apartment_type::multi_threaded);
        if (!GraphicsCaptureSession::IsSupported()) return 4;
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
                next = now + std::chrono::microseconds(1000000 / fps);
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
