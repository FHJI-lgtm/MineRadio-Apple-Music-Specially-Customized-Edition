// LoopbackSelfTest.cpp - decisive: our process RENDERS a sine AND simultaneously
// attempts PROCESS LOOPBACK activation targeting our OWN PID. If activation
// succeeds while we are demonstrably rendering -> the API works, Apple Music
// just isn't rendering. If activation fails (0x80070002) while rendering ->
// the process-loopback device path/API itself fails on this machine.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <stdint.h>
#include <math.h>

static const GUID CLSID_MMDeviceEnumerator_ = { 0xBCDE0395, 0xE52F, 0x467C, { 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E } };
static const GUID IID_IMMDeviceEnumerator_ = { 0xA95664D2, 0x9614, 0x4F35, { 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6 } };
static const GUID IID_IAudioClient_ = { 0x1CB9AD4C, 0xDBFA, 0x4c32, { 0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2 } };
static const GUID IID_IAudioCaptureClient_ = { 0xC8ADBD64, 0xE71E, 0x48a0, { 0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17 } };
static const GUID IID_IAudioRenderClient_ = { 0xF294ACFC, 0x3146, 0x4483, { 0xA7, 0xBF, 0xAD, 0xDC, 0xA7, 0xC2, 0x60, 0xE2 } };
static const GUID IID_IActivateAudioInterfaceCompletionHandler_ = { 0x41d949ab, 0x9862, 0x444a, { 0x80, 0xf6, 0xc2, 0x61, 0x33, 0x4d, 0xa5, 0xeb } };
static const GUID IID_IActivateAudioInterfaceAsyncOperation_ = { 0x72a22d78, 0xcde4, 0x431d, { 0xb8, 0xcc, 0x84, 0x3a, 0x71, 0x19, 0x9b, 0x6d } };

typedef enum AudioClientActivationType { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 } AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum ProcessLoopbackMode { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1 } PROCESS_LOOPBACK_MODE;
typedef struct PROCESS_LOOPBACK_PARAMS { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE ProcessLoopbackMode; } PROCESS_LOOPBACK_PARAMS;
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS { AUDIOCLIENT_ACTIVATION_TYPE ActivationType; union { PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; } DUMMYUNIONNAME; } AUDIOCLIENT_ACTIVATION_PARAMS;
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"\\\\?\\VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK"

static HANDLE g_done = nullptr;
static HRESULT g_hr = E_FAIL;
static IAudioClient* g_client = nullptr;

class Handler : public IUnknown {
    volatile LONG refs = 1;
public:
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        // agile: also respond to IAgileObject (marker) - required by the API
        static const GUID IID_IAgileObject = { 0x94ea2b94, 0xe9cc, 0x49e0, { 0xc0, 0xff, 0xee, 0x64, 0xca, 0x8f, 0x5b, 0x90 } };
        if (riid == IID_IUnknown || riid == IID_IActivateAudioInterfaceCompletionHandler_ || riid == IID_IAgileObject) {
            *ppv = this; InterlockedIncrement(&refs); return S_OK;
        }
        *ppv = nullptr; return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return (ULONG)InterlockedIncrement(&refs); }
    STDMETHODIMP_(ULONG) Release() override { LONG r = InterlockedDecrement(&refs); if (r == 0) delete this; return (ULONG)r; }
    STDMETHODIMP ActivateCompleted(void* op) {
        printf("[SELFTEST] activation callback entered\n");
        // op -> IActivateAudioInterfaceAsyncOperation vtable: [0..2] IUnknown, [3] GetActivateResult
        typedef HRESULT(STDMETHODCALLTYPE* FnGetActivateResult)(void*, HRESULT*, void**);
        FnGetActivateResult f = *(FnGetActivateResult*)(*(void***)op + 3);
        void* iface = nullptr;
        HRESULT hrGet = f(op, &g_hr, &iface);
        printf("[SELFTEST] activation result hr=0x%08X (get=0x%08X) iface=%s\n", (unsigned)g_hr, (unsigned)hrGet, iface ? "non-null" : "null");
        if (SUCCEEDED(hrGet) && SUCCEEDED(g_hr) && iface) { ((IUnknown*)iface)->QueryInterface(IID_IAudioClient_, (void**)&g_client); ((IUnknown*)iface)->Release(); }
        SetEvent(g_done);
        return S_OK;
    }
};

typedef HRESULT(WINAPI* FnActivateAudioInterfaceAsync)(LPCWSTR, const GUID*, PROPVARIANT*, IUnknown*, void**);

int wmain() {
    printf("=== LoopbackSelfTest (render + process-loopback on own pid %lu) ===\n", (unsigned long)GetCurrentProcessId());
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    printf("CoInitializeEx = 0x%08X\n", (unsigned)hr);
    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator_, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator_, (void**)&enumerator);
    if (FAILED(hr)) { printf("no enumerator\n"); return 1; }
    IMMDevice* def = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &def);
    if (FAILED(hr) || !def) { printf("no default endpoint\n"); return 1; }

    // --- start rendering a sine ---
    IAudioClient* renClient = nullptr;
    hr = def->Activate(IID_IAudioClient_, CLSCTX_ALL, nullptr, (void**)&renClient);
    WAVEFORMATEX* mix = nullptr;
    if (SUCCEEDED(hr)) hr = renClient->GetMixFormat(&mix);
    if (SUCCEEDED(hr)) hr = renClient->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1000000, 0, mix, nullptr);
    IAudioRenderClient* ren = nullptr;
    if (SUCCEEDED(hr)) hr = renClient->GetService(IID_IAudioRenderClient_, (void**)&ren);
    UINT32 bufFrames = 0;
    if (SUCCEEDED(hr)) renClient->GetBufferSize(&bufFrames);
    if (SUCCEEDED(hr) && bufFrames > 0) {
        BYTE* dp = nullptr;
        ren->GetBuffer(bufFrames, &dp);
        if (dp) {
            float* data = (float*)dp;
            for (UINT32 f = 0; f < bufFrames; f++) {
                float v = (float)(0.25 * sin(2.0 * 3.14159 * 440.0 * f / mix->nSamplesPerSec));
                for (WORD c = 0; c < mix->nChannels; c++) data[f * mix->nChannels + c] = v;
            }
            ren->ReleaseBuffer(bufFrames, 0);
        }
        hr = renClient->Start();
    }
    printf("render started = 0x%08X (own process now rendering)\n", (unsigned)hr);

    // --- process loopback activation on OUR OWN pid ---
    HMODULE mmdev = LoadLibraryW(L"mmdevapi.dll");
    auto fn = (FnActivateAudioInterfaceAsync)GetProcAddress(mmdev, "ActivateAudioInterfaceAsync");
    AUDIOCLIENT_ACTIVATION_PARAMS params; ZeroMemory(&params, sizeof(params));
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = GetCurrentProcessId();
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT pv; ZeroMemory(&pv, sizeof(pv));
    pv.vt = VT_BLOB; pv.blob.cbSize = sizeof(params); pv.blob.pBlobData = (BYTE*)&params;
    g_done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    Handler* handler = new Handler();
    void* asyncOp = nullptr;
    hr = fn(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IID_IAudioClient_, &pv, handler, &asyncOp);
    printf("ActivateAudioInterfaceAsync(process loopback, self) = 0x%08X cbSize=%u\n", (unsigned)hr, (unsigned)pv.blob.cbSize);
    if (SUCCEEDED(hr)) {
        WaitForSingleObject(g_done, 8000);
        printf("SELFTEST: activation result = 0x%08X -> %s\n", (unsigned)g_hr, SUCCEEDED(g_hr) ? "SUCCESS" : "FAIL");
    } else {
        printf("SELFTEST: call failed, no callback\n");
    }
    printf("=== done ===\n");
    return 0;
}
