// PathProbe.cpp - systematic ActivateAudioInterfaceAsync matrix on the real
// audio stack. Uses the PROVEN handler pattern (agile, IAgileObject) that
// already showed "callback entered" in MineRadioAudioCapture.
// A: virtual process-loopback path + process-loopback params   (current impl)
// B: real render endpoint path + process-loopback params
// C: virtual process-loopback path + DEFAULT activation (empty params)
// D: real render endpoint path + DEFAULT activation (docs "safe" case)
#define WIN32_LEAN_AND_MEAN
#define INITGUID
#include <windows.h>
#include <objbase.h>
#include <objidl.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <stdio.h>
#include <stdint.h>
#include <string>

#ifndef AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
typedef enum AudioClientActivationType { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 } AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum ProcessLoopbackMode { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1 } PROCESS_LOOPBACK_MODE;
typedef struct PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE ProcessLoopbackMode; } PROCESS_LOOPBACK_PARAMS;
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS { AUDIOCLIENT_ACTIVATION_TYPE ActivationType; union { PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; } DUMMYUNIONNAME; } AUDIOCLIENT_ACTIVATION_PARAMS;
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"\\\\?\\VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK"
#endif

class Handler : public IAgileObject, public IActivateAudioInterfaceCompletionHandler {
    volatile LONG refs = 1;
public:
    HANDLE done;
    HRESULT hr;
    void* client;
    Handler() : done(CreateEventW(nullptr, TRUE, FALSE, nullptr)), hr(E_FAIL), client(nullptr) {}
    ~Handler() { if (done) CloseHandle(done); }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (riid == IID_IUnknown) *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        else if (riid == IID_IAgileObject) *ppv = static_cast<IAgileObject*>(this);
        else if (riid == IID_IActivateAudioInterfaceCompletionHandler) *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        else { *ppv = nullptr; return E_NOINTERFACE; }
        InterlockedIncrement(&refs); return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return (ULONG)InterlockedIncrement(&refs); }
    STDMETHODIMP_(ULONG) Release() override { LONG r = InterlockedDecrement(&refs); if (r == 0) delete this; return (ULONG)r; }
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        printf("   [callback entered]\n");
        IUnknown* punk = nullptr;
        HRESULT hrGet = op->GetActivateResult(&hr, &punk);
        printf("   activation result hr=0x%08X (get=0x%08X) iface=%s\n", (unsigned)hr, (unsigned)hrGet, punk ? "non-null" : "null");
        if (SUCCEEDED(hrGet) && SUCCEEDED(hr) && punk) { punk->QueryInterface(IID_PPV_ARGS((IAudioClient**)&client)); punk->Release(); }
        SetEvent(done);
        return S_OK;
    }
};

typedef HRESULT(WINAPI* FnActivateAudioInterfaceAsync)(LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*, IActivateAudioInterfaceAsyncOperation**);

static void TryActivate(const char* label, FnActivateAudioInterfaceAsync fn, LPCWSTR path, const AUDIOCLIENT_ACTIVATION_PARAMS* params, DWORD pid) {
    AUDIOCLIENT_ACTIVATION_PARAMS local; ZeroMemory(&local, sizeof(local));
    if (params) local = *params;
    PROPVARIANT pv; ZeroMemory(&pv, sizeof(pv));
    if (params) { pv.vt = VT_BLOB; pv.blob.cbSize = sizeof(AUDIOCLIENT_ACTIVATION_PARAMS); pv.blob.pBlobData = (BYTE*)&local; }
    Handler* h = new Handler();
    IActivateAudioInterfaceAsyncOperation* op = nullptr;
    HRESULT hr = fn(path, IID_IAudioClient, &pv, h, &op);
    printf("[%s] ActivateAudioInterfaceAsync hr=0x%08X\n", label, (unsigned)hr);
    if (SUCCEEDED(hr)) {
        WaitForSingleObject(h->done, 8000);
        printf("[%s] final = 0x%08X %s\n", label, (unsigned)h->hr, SUCCEEDED(h->hr) ? "(SUCCESS)" : "(FAIL)");
    }
    if (op) op->Release();
    h->Release();
}

int wmain() {
    printf("=== PathProbe (pid=%lu) ===\n", (unsigned long)GetCurrentProcessId());
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    printf("CoInitializeEx = 0x%08X\n", (unsigned)hr);
    HMODULE mmdev = LoadLibraryW(L"mmdevapi.dll");
    auto fn = (FnActivateAudioInterfaceAsync)GetProcAddress(mmdev, "ActivateAudioInterfaceAsync");

    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator, (void**)&enumerator);
    IMMDevice* def = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &def);
    LPWSTR defId = nullptr;
    def->GetId(&defId);
    std::wstring devPath = L"\\\\?\\SWD#MMDEVAPI#" + std::wstring(defId) + L"#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
    printf("default endpoint id=%ls\n", defId ? defId : L"?");

    DWORD pid = GetCurrentProcessId();
    AUDIOCLIENT_ACTIVATION_PARAMS loopParams; ZeroMemory(&loopParams, sizeof(loopParams));
    loopParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    loopParams.ProcessLoopbackParams.TargetProcessId = pid;
    loopParams.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    TryActivate("A virtual+loopback", fn, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &loopParams, pid);
    TryActivate("B realep+loopback ", fn, devPath.c_str(), &loopParams, pid);
    TryActivate("C virtual+default ", fn, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, nullptr, pid);
    TryActivate("D realep+default  ", fn, devPath.c_str(), nullptr, pid);
    printf("=== done ===\n");
    return 0;
}
