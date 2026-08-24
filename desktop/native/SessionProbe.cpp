// SessionProbe.cpp - enumerate audio sessions per render endpoint and show
// which process owns active (playing) sessions. Answers: does any process
// (e.g. AppleMusic.exe) actually have an active audio rendering stream?
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <stdio.h>

static const GUID CLSID_MMDeviceEnumerator_ = { 0xBCDE0395, 0xE52F, 0x467C, { 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E } };
static const GUID IID_IMMDeviceEnumerator_ = { 0xA95664D2, 0x9614, 0x4F35, { 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6 } };
static const GUID IID_IAudioSessionManager2_ = { 0x77AA99A0, 0x1BD6, 0x484F, { 0x8B, 0xC7, 0x2C, 0x65, 0x4C, 0x9A, 0x9B, 0x6F } };

typedef HRESULT(STDMETHODCALLTYPE* FnGetSessionEnumerator)(void* self, void** outEnum);
typedef HRESULT(STDMETHODCALLTYPE* FnGetCount)(void* self, int* outCount);
typedef HRESULT(STDMETHODCALLTYPE* FnGetSession)(void* self, int idx, void** outSession);
typedef HRESULT(STDMETHODCALLTYPE* FnGetProcessId)(void* self, DWORD* outPid);
typedef HRESULT(STDMETHODCALLTYPE* FnGetState)(void* self, int* outState);
typedef HRESULT(STDMETHODCALLTYPE* FnGetDisplayName)(void* self, wchar_t** outName);
typedef HRESULT(STDMETHODCALLTYPE* FnRelease)(void* self);

int wmain() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    printf("CoInitializeEx = 0x%08X\n", (unsigned)hr);
    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator_, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator_, (void**)&enumerator);
    if (FAILED(hr) || !enumerator) { printf("no enumerator\n"); return 1; }

    IMMDeviceCollection* coll = nullptr;
    hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &coll);
    UINT count = 0;
    if (SUCCEEDED(hr) && coll) coll->GetCount(&count);
    printf("render endpoints: %u\n", count);

    IMMDevice* def = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &def);
    LPWSTR defId = nullptr;
    if (SUCCEEDED(hr) && def) def->GetId(&defId);
    printf("DEFAULT endpoint id=%ls\n", defId ? defId : L"?");
    if (defId) CoTaskMemFree(defId);
    if (def) def->Release();

    for (UINT i = 0; i < count; i++) {
        IMMDevice* dev = nullptr;
        if (FAILED(coll->Item(i, &dev))) continue;
        LPWSTR id = nullptr;
        dev->GetId(&id);
        printf("\n--- endpoint %u id=%ls ---\n", i, id ? id : L"?");
        if (id) CoTaskMemFree(id);
        void* mgr = nullptr;
        hr = dev->Activate(IID_IAudioSessionManager2_, CLSCTX_ALL, nullptr, (void**)&mgr);
        if (FAILED(hr) || !mgr) { printf("  no session manager (0x%08X)\n", (unsigned)hr); dev->Release(); continue; }
        void** mgrv = *(void***)mgr;
        FnGetSessionEnumerator fGetEnum = (FnGetSessionEnumerator)mgrv[5];
        void* sessionEnum = nullptr;
        hr = fGetEnum(mgr, &sessionEnum);
        if (FAILED(hr) || !sessionEnum) { printf("  GetSessionEnumerator failed 0x%08X\n", (unsigned)hr); ((FnRelease)mgrv[2])(mgr); dev->Release(); continue; }
        void** evt = *(void***)sessionEnum;
        FnGetCount fGetCount = (FnGetCount)evt[3];
        FnGetSession fGetSession = (FnGetSession)evt[4];
        int n = 0;
        fGetCount(sessionEnum, &n);
        printf("  sessions: %d\n", n);
        for (int s = 0; s < n && s < 128; s++) {
            void* ctl = nullptr;
            if (FAILED(fGetSession(sessionEnum, s, &ctl)) || !ctl) continue;
            void** cvt = *(void***)ctl;
            FnGetProcessId fPid = (FnGetProcessId)cvt[14];
            FnGetState fState = (FnGetState)cvt[3];
            FnGetDisplayName fName = (FnGetDisplayName)cvt[4];
            DWORD pid = 0; int state = -1; wchar_t* name = nullptr;
            fPid(ctl, &pid);
            fState(ctl, &state);
            if (SUCCEEDED(fName(ctl, &name)) && name) { }
            const char* st = state == 0 ? "INACTIVE" : state == 1 ? "ACTIVE" : state == 2 ? "EXPIRED" : "?";
            printf("    pid=%lu state=%s(%d) name=%ls\n", (unsigned long)pid, st, state, name ? name : L"");
            if (name) CoTaskMemFree(name);
            ((FnRelease)cvt[2])(ctl);
        }
        ((FnRelease)evt[2])(sessionEnum);
        ((FnRelease)mgrv[2])(mgr);
        dev->Release();
    }
    printf("\n=== done ===\n");
    return 0;
}
