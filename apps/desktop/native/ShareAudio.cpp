// Windows process-loopback capture. Only the native host chooses the window
// or process; PCM is written to its pipe, never a file or network endpoint.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <propidl.h>
#include <cstdio>
#include <cstdint>
#include <vector>
#include <atomic>
#include <thread>

struct ProcessLoopback { DWORD processId; DWORD mode; };
struct ActivationParameters { DWORD type; ProcessLoopback process; };

class Activation final : public IActivateAudioInterfaceCompletionHandler {
  LONG references = 1;
  IUnknown* marshaler = nullptr;
public:
  HANDLE done = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT result = E_PENDING;
  IAudioClient* client = nullptr;
  Activation() { CoCreateFreeThreadedMarshaler(this, &marshaler); }
  ~Activation() { if (client) client->Release(); if (marshaler) marshaler->Release(); CloseHandle(done); }
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id, void** object) override {
    if (!object) return E_POINTER;
    *object = nullptr;
    if (id == IID_IUnknown || id == __uuidof(IActivateAudioInterfaceCompletionHandler) || id == IID_IAgileObject) *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
    else if (id == IID_IMarshal && marshaler) return marshaler->QueryInterface(id, object);
    else return E_NOINTERFACE;
    AddRef(); return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references); }
  ULONG STDMETHODCALLTYPE Release() override { LONG left = InterlockedDecrement(&references); if (!left) delete this; return left; }
  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    IUnknown* audio = nullptr;
    HRESULT activated = E_FAIL;
    result = operation->GetActivateResult(&activated, &audio);
    if (SUCCEEDED(result)) result = activated;
    if (SUCCEEDED(result)) result = audio->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&client));
    if (audio) audio->Release(); SetEvent(done); return S_OK;
  }
};

static bool writeAll(HANDLE pipe, const void* buffer, DWORD length) {
  auto bytes = static_cast<const BYTE*>(buffer);
  while (length) { DWORD written = 0; if (!WriteFile(pipe, bytes, length, &written, nullptr) || !written) return false; bytes += written; length -= written; }
  return true;
}

int wmain(int count, wchar_t** arguments) {
  // include-window <HWND> <parent PID>, or exclude-process <own PID> <parent PID>.
  if (count != 4) return 2;
  wchar_t* end = nullptr;
  const unsigned long long identifier = wcstoull(arguments[2], &end, 10);
  if (!identifier || !end || *end) return 2;
  const DWORD parentId = wcstoul(arguments[3], &end, 10);
  if (!parentId || !end || *end) return 2;
  const bool window = wcscmp(arguments[1], L"include-window") == 0;
  if (!window && wcscmp(arguments[1], L"exclude-process") != 0) return 2;
  DWORD target = static_cast<DWORD>(identifier);
  HWND handle = reinterpret_cast<HWND>(static_cast<uintptr_t>(identifier));
  if (window && (!IsWindow(handle) || !GetWindowThreadProcessId(handle, &target))) return 3;
  if (!target || (window && target == parentId)) return 3;
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parentId);
  if (!parent) return 3;
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 4;
  auto completion = new Activation();
  ActivationParameters parameters { 1, { target, window ? 0u : 1u } };
  PROPVARIANT variant {}; variant.vt = VT_BLOB; variant.blob.cbSize = sizeof(parameters); variant.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);
  IActivateAudioInterfaceAsyncOperation* operation = nullptr;
  HRESULT hr = ActivateAudioInterfaceAsync(L"VAD\\Process_Loopback", __uuidof(IAudioClient), &variant, completion, &operation);
  const char* stage = "activation";
  if (SUCCEEDED(hr) && WaitForSingleObject(completion->done, 8000) == WAIT_OBJECT_0) hr = completion->result;
  else if (SUCCEEDED(hr)) hr = HRESULT_FROM_WIN32(ERROR_TIMEOUT);
  IAudioClient* client = completion->client;
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  IAudioCaptureClient* capture = nullptr;
  if (SUCCEEDED(hr)) {
    WAVEFORMATEX format {}; format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; format.nChannels = 2; format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 32; format.nBlockAlign = 8; format.nAvgBytesPerSec = 384000;
    stage = "initialize";
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 0, 0, &format, nullptr);
    if (SUCCEEDED(hr)) hr = client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(&capture));
    if (SUCCEEDED(hr)) hr = client->SetEventHandle(ready);
    if (SUCCEEDED(hr)) hr = client->Start();
  }
  std::atomic<bool> running { SUCCEEDED(hr) };
  if (SUCCEEDED(hr)) {
    // Closing stdin or the parent stops capture, including crash/renderer cleanup.
    std::thread([&running] { char byte; DWORD read; while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &read, nullptr) && read) {} running = false; }).detach();
    fprintf(stderr, "READY 48000 2\n"); fflush(stderr);
    HANDLE waits[] { ready, parent };
    while (running) {
      DWORD result = WaitForMultipleObjects(2, waits, FALSE, 250);
      if (result == WAIT_OBJECT_0 + 1 || result == WAIT_FAILED || (window && !IsWindow(handle))) break;
      if (result != WAIT_OBJECT_0) continue;
      UINT32 available = 0;
      while (running && SUCCEEDED(hr = capture->GetNextPacketSize(&available)) && available) {
        BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0;
        hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
        if (FAILED(hr)) break;
        // Bound each copy even if a driver supplies a malformed packet.
        if (frames > 48000) { capture->ReleaseBuffer(frames); hr = E_UNEXPECTED; break; }
        std::vector<BYTE> pcm(frames * 8, 0);
        if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT)) CopyMemory(pcm.data(), data, pcm.size());
        capture->ReleaseBuffer(frames);
        if (!writeAll(GetStdHandle(STD_OUTPUT_HANDLE), pcm.data(), static_cast<DWORD>(pcm.size()))) { running = false; break; }
      }
      if (FAILED(hr)) break;
    }
    client->Stop();
  }
  if (FAILED(hr)) { fprintf(stderr, "ERROR %s %08lx\n", stage, static_cast<unsigned long>(hr)); fflush(stderr); }
  // stdin's detached thread ends with this process; do not return through a
  // destroyed stack while it still has a reference to the stop flag.
  if (capture) capture->Release(); if (operation) operation->Release();
  completion->Release(); CloseHandle(ready); CloseHandle(parent);
  ExitProcess(FAILED(hr) ? 5 : 0);
}
