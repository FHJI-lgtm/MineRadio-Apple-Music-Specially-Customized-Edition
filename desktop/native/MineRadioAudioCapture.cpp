// ============================================================
// MineRadioAudioCapture.cpp
// Native Process Loopback audio capture helper for Mineradio.
// Reference implementation: microsoft/Windows-classic-samples
//   "Application Loopback Audio Capture" (official sample) - the
//   activation ABI below follows it exactly.
//
// Usage:
//   MineRadioAudioCapture.exe <PID>
//
// stdout (JSONL only):
//   {"type":"ready","pid":<pid>}
//   {"type":"metrics","rms":0.32,"bass":0,"mid":0,"treble":0}   (~20/s)
// stderr: [AUDIO] ... diagnostic logs
//
// Exit: Ctrl+C, stdin EOF (pipe closed), or activation failure.
// Phase 2 scope: prove AppleMusic -> Process Loopback -> IAudioClient
// -> PCM. Only RMS is computed for now (no FFT yet).
//
// Build:
//   MSVC : cl /nologo /O2 /EHsc MineRadioAudioCapture.cpp /Fe:MineRadioAudioCapture.exe /link ole32.lib
//   MinGW: g++ -O2 -static -o MineRadioAudioCapture.exe MineRadioAudioCapture.cpp -lole32
// ============================================================
#define WIN32_LEAN_AND_MEAN
#define INITGUID
#include <windows.h>
#include <objbase.h>
#include <objidl.h>
#include <rpcndr.h>
#include <guiddef.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <mmreg.h>
#include <ksmedia.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <math.h>

// ---- Process-loopback ABI definitions ----
// Official source (Windows SDK header "audioclientactivationparams.h", and the
// Microsoft Learn reference):
//   https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/
//   https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params
// mingw-w64 headers (w64devkit) do not ship these yet, so they are reproduced
// here VERBATIM from the official definitions. If the local Windows SDK is
// present, prefer compiling with it and delete this block.
#ifndef AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
typedef enum AudioClientActivationType {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum ProcessLoopbackMode {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;
typedef struct PROCESS_LOOPBACK_PARAMS {
    DWORD TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} PROCESS_LOOPBACK_PARAMS;
typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union { PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; } DUMMYUNIONNAME;
} AUDIOCLIENT_ACTIVATION_PARAMS;
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"\\\\?\\VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK"
#endif

// INITGUID (defined above) makes the SDK/mingw headers define every IID/GUID
// in this TU - no manual DEFINE_GUID needed here.
// The two callback interfaces themselves are declared by mmdeviceapi.h.

static HANDLE g_done = nullptr;
static HRESULT g_hr = E_FAIL;
static IAudioClient* g_client = nullptr;

// Completion handler. Must be AGILE: ActivateAudioInterfaceAsync returns
// E_ILLEGAL_METHOD_CALL if the callback object is not agile (documented,
// independent of the apartment). IAgileObject is a marker interface that
// declares the object freely marshalable.
class CompletionHandler : public IAgileObject, public IActivateAudioInterfaceCompletionHandler {
    volatile LONG refs = 1;
public:
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (riid == IID_IUnknown) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        } else if (riid == IID_IAgileObject) {
            *ppv = static_cast<IAgileObject*>(this);
        } else if (riid == IID_IActivateAudioInterfaceCompletionHandler) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        } else {
            *ppv = nullptr;
            return E_NOINTERFACE;
        }
        InterlockedIncrement(&refs);
        return S_OK;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return (ULONG)InterlockedIncrement(&refs); }
    STDMETHODIMP_(ULONG) Release() override {
        LONG r = InterlockedDecrement(&refs);
        if (r == 0) delete this;
        return (ULONG)r;
    }
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        fprintf(stderr, "[AUDIO] activation callback entered\n");
        IUnknown* punk = nullptr;
        HRESULT hrGet = op->GetActivateResult(&g_hr, &punk);
        fprintf(stderr, "[AUDIO] activation result hr=0x%08X (get=0x%08X)\n",
            (unsigned)g_hr, (unsigned)hrGet);
        if (SUCCEEDED(hrGet) && SUCCEEDED(g_hr) && punk) {
            punk->QueryInterface(IID_PPV_ARGS(&g_client));
            punk->Release();
        }
        SetEvent(g_done);
        return S_OK;
    }
};

typedef HRESULT(WINAPI* FnActivateAudioInterfaceAsync)(
    LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*,
    IActivateAudioInterfaceAsyncOperation**);

int wmain(int argc, wchar_t* argv[]) {
    if (argc < 2) { fprintf(stderr, "usage: MineRadioAudioCapture.exe <PID>\n"); return 2; }
    DWORD pid = (DWORD)_wtoi(argv[1]);
    if (pid == 0) { fprintf(stderr, "[AUDIO] invalid pid\n"); return 2; }
    fprintf(stderr, "[AUDIO] target pid: %lu\n", (unsigned long)pid);

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    fprintf(stderr, "[AUDIO] CoInitializeEx hr=0x%08X\n", (unsigned)hr);
    if (FAILED(hr)) { fprintf(stderr, "[AUDIO] CoInitializeEx failed 0x%08X\n", (unsigned)hr); return 1; }

    HMODULE mmdev = LoadLibraryW(L"mmdevapi.dll");
    if (!mmdev) { fprintf(stderr, "[AUDIO] mmdevapi.dll load failed\n"); return 1; }
    auto fn = (FnActivateAudioInterfaceAsync)GetProcAddress(mmdev, "ActivateAudioInterfaceAsync");
    if (!fn) { fprintf(stderr, "[AUDIO] ActivateAudioInterfaceAsync not exported\n"); return 1; }

    // AUDIOCLIENT_ACTIVATION_PARAMS - exact ABI per the official sample.
    AUDIOCLIENT_ACTIVATION_PARAMS params;
    ZeroMemory(&params, sizeof(params));
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

    // NOTE (machine-verified): on this build the virtual device path
    // VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK returns ERROR_FILE_NOT_FOUND
    // (0x80070002), but process-loopback activation against the REAL default
    // render endpoint path succeeds (IAudioClient returned). Resolve the
    // default endpoint at runtime and use its render-interface device path.
    wchar_t devPath[512] = L"";
    {
        IMMDeviceEnumerator* enumerator = nullptr;
        HRESULT hrE = CoCreateInstance(CLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator, (void**)&enumerator);
        if (SUCCEEDED(hrE) && enumerator) {
            IMMDevice* def = nullptr;
            hrE = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &def);
            if (SUCCEEDED(hrE) && def) {
                LPWSTR id = nullptr;
                if (SUCCEEDED(def->GetId(&id)) && id) {
                    _snwprintf(devPath, 511, L"\\\\?\\SWD#MMDEVAPI#%s#{e6327cad-dcec-4949-ae8a-991e976a79d2}", id);
                    CoTaskMemFree(id);
                }
                def->Release();
            }
            enumerator->Release();
        }
    }
    LPCWSTR activationPath = devPath[0] ? devPath : VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK;
    fprintf(stderr, "[AUDIO] activation device path: %ls\n", activationPath);

    PROPVARIANT pv;
    ZeroMemory(&pv, sizeof(pv));
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(AUDIOCLIENT_ACTIVATION_PARAMS);
    pv.blob.pBlobData = (BYTE*)&params;

    g_done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!g_done) { fprintf(stderr, "[AUDIO] CreateEvent failed\n"); return 1; }
    CompletionHandler* handler = new CompletionHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    hr = fn(activationPath, IID_IAudioClient, &pv, handler, &asyncOp);
    fprintf(stderr, "[AUDIO] ActivateAudioInterfaceAsync hr=0x%08X cbSize=%u pid=%lu\n",
        (unsigned)hr, (unsigned)pv.blob.cbSize, (unsigned long)pid);
    if (FAILED(hr)) { handler->Release(); return 1; }

    WaitForSingleObject(g_done, 10000);
    if (FAILED(g_hr)) {
        fprintf(stderr, "[AUDIO] process loopback activate failed hr=0x%08X\n", (unsigned)g_hr);
        handler->Release();
        if (asyncOp) asyncOp->Release();
        return 1;
    }
    fprintf(stderr, "[AUDIO] activation OK\n");
    IAudioClient* client = g_client;
    handler->Release();
    if (asyncOp) asyncOp->Release();

    // ---- IAudioClient setup (loopback shared mode) ----
    WAVEFORMATEX* mix = nullptr;
    hr = client->GetMixFormat(&mix);
    if (FAILED(hr)) { fprintf(stderr, "[AUDIO] GetMixFormat failed 0x%08X\n", (unsigned)hr); return 1; }
    WORD fmtTag = mix->wFormatTag;
    WORD channels = mix->nChannels;
    DWORD sampleRate = mix->nSamplesPerSec;
    bool isFloat = false;
    if (fmtTag == WAVE_FORMAT_EXTENSIBLE && mix->cbSize >= 22) {
        WAVEFORMATEXTENSIBLE* ext = (WAVEFORMATEXTENSIBLE*)mix;
        // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT == {0x00000003,0x0000,0x0010,{0x80,0x00,...}}
        // compare only Data1 to avoid needing the GUID symbol.
        isFloat = (*(const DWORD*)&ext->SubFormat == 3);
    } else {
        isFloat = (fmtTag == WAVE_FORMAT_IEEE_FLOAT);
    }
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 0, 0, mix, &GUID_NULL);
    CoTaskMemFree(mix);
    if (FAILED(hr)) { fprintf(stderr, "[AUDIO] Initialize failed 0x%08X\n", (unsigned)hr); return 1; }

    IAudioCaptureClient* capture = nullptr;
    hr = client->GetService(IID_IAudioCaptureClient, (void**)&capture);
    if (FAILED(hr)) { fprintf(stderr, "[AUDIO] GetService failed 0x%08X\n", (unsigned)hr); return 1; }

    UINT32 bufFrames = 0;
    client->GetBufferSize(&bufFrames);
    fprintf(stderr, "[AUDIO] audio client initialized (sr=%lu ch=%u float=%d buf=%u)\n",
        (unsigned long)sampleRate, (unsigned)channels, isFloat ? 1 : 0, (unsigned)bufFrames);
    hr = client->Start();
    if (FAILED(hr)) { fprintf(stderr, "[AUDIO] Start failed 0x%08X\n", (unsigned)hr); return 1; }
    fprintf(stderr, "[AUDIO] capture started\n");
    printf("{\"type\":\"ready\",\"pid\":%lu}\n", (unsigned long)pid);
    fflush(stdout);

    // ---- capture loop: mono mix + RMS + FFT bands, emit ~20/s ----
    const int FFT_SIZE = 2048;
    static double s_ring[2048];
    static int s_ringPos = 0;
    static double s_fftRe[2048], s_fftIm[2048];
    static double s_bands[64];
    static double s_bass = 0, s_mid = 0, s_treble = 0;
    static bool s_hasSpectrum = false;

    auto fft = [](double* re, double* im, int n) {
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) { double tr = re[i]; re[i] = re[j]; re[j] = tr; tr = im[i]; im[i] = im[j]; im[j] = tr; }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = -2.0 * 3.14159265358979 / len;
            double wr = cos(ang), wi = sin(ang);
            for (int i = 0; i < n; i += len) {
                double cr = 1, ci = 0;
                for (int k = 0; k < len / 2; k++) {
                    int a = i + k, b = i + k + len / 2;
                    double tr = re[b] * cr - im[b] * ci;
                    double ti = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] = re[a] + tr; im[a] = im[a] + ti;
                    double ncr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = ncr;
                }
            }
        }
    };
    auto analyze = [&]() {
        for (int i = 0; i < FFT_SIZE; i++) {
            int idx = (s_ringPos + i) % FFT_SIZE;
            double w = 0.5 - 0.5 * cos(2.0 * 3.14159265358979 * i / (FFT_SIZE - 1));
            s_fftRe[i] = s_ring[idx] * w;
            s_fftIm[i] = 0;
        }
        fft(s_fftRe, s_fftIm, FFT_SIZE);
        int half = FFT_SIZE / 2;
        double magMax = 1e-9;
        double mag[1024];
        for (int i = 0; i < half; i++) {
            mag[i] = sqrt(s_fftRe[i] * s_fftRe[i] + s_fftIm[i] * s_fftIm[i]) / FFT_SIZE;
            if (mag[i] > magMax) magMax = mag[i];
        }
        double fMin = 20.0, fMax = sampleRate / 2.0 < 20000.0 ? sampleRate / 2.0 : 20000.0;
        double logMin = log10(fMin), logMax = log10(fMax);
        double bandWeight = 1.0 / (magMax * 0.9 > 1e-6 ? magMax * 0.9 : 1e-6);
        for (int b = 0; b < 64; b++) {
            double f0 = pow(10, logMin + (logMax - logMin) * b / 64);
            double f1 = pow(10, logMin + (logMax - logMin) * (b + 1) / 64);
            int bin0 = (int)(f0 * FFT_SIZE / sampleRate);
            int bin1 = (int)ceil(f1 * FFT_SIZE / sampleRate);
            if (bin0 < 1) bin0 = 1;
            if (bin1 > half) bin1 = half;
            double acc = 0; int n = 0;
            for (int k = bin0; k < bin1 && k < half; k++) { acc += mag[k]; n++; }
            double v = (n > 0 ? acc / n : 0) * bandWeight;
            if (v > 1.0) v = 1.0;
            s_bands[b] = v;
        }
        double bass = 0, mid = 0, treble = 0;
        for (int i = 0; i < 8; i++) bass += s_bands[i];
        for (int i = 8; i < 22; i++) mid += s_bands[i];
        for (int i = 22; i < 64; i++) treble += s_bands[i];
        s_bass = fmin(1, bass / 8); s_mid = fmin(1, mid / 14); s_treble = fmin(1, treble / 42);
        s_hasSpectrum = true;
    };

    double sumSq = 0; uint64_t count = 0;
    ULONGLONG lastEmit = GetTickCount64();
    ULONGLONG lastDbg = 0;
    HANDLE hIn = GetStdHandle(STD_INPUT_HANDLE);
    while (true) {
        UINT32 packet = 0;
        while (capture->GetNextPacketSize(&packet) == S_OK && packet > 0) {
            BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0; UINT64 devPos = 0, qpc = 0;
            HRESULT hr2 = capture->GetBuffer(&data, &frames, &flags, &devPos, &qpc);
            if (FAILED(hr2)) break;
            if (frames > 0 && data) {
                if (isFloat) {
                    const float* p = (const float*)data;
                    for (UINT32 f = 0; f < frames; f++) {
                        float s = 0;
                        for (WORD c = 0; c < channels; c++) s += p[f * channels + c];
                        s /= channels;
                        sumSq += (double)s * s; count++;
                        s_ring[s_ringPos] = s; s_ringPos = (s_ringPos + 1) % FFT_SIZE;
                        if (s_ringPos == 0) analyze();
                    }
                } else {
                    const INT16* p = (const INT16*)data;
                    for (UINT32 f = 0; f < frames; f++) {
                        int s = 0;
                        for (WORD c = 0; c < channels; c++) s += p[f * channels + c];
                        double v = (double)s / channels / 32768.0;
                        sumSq += v * v; count++;
                        s_ring[s_ringPos] = v; s_ringPos = (s_ringPos + 1) % FFT_SIZE;
                        if (s_ringPos == 0) analyze();
                    }
                }
            }
            capture->ReleaseBuffer(frames);
        }
        ULONGLONG now = GetTickCount64();
        if (now - lastEmit >= 50) {
            double rms = count > 0 ? sqrt(sumSq / count) : 0.0;
            if (rms > 1.0) rms = 1.0;
            if (s_hasSpectrum) {
                printf("{\"type\":\"metrics\",\"rms\":%.3f,\"bass\":%.3f,\"mid\":%.3f,\"treble\":%.3f,\"spectrum\":[",
                    rms, s_bass, s_mid, s_treble);
                for (int i = 0; i < 64; i++) { if (i) printf(","); printf("%.3f", s_bands[i]); }
                printf("]}\n");
            } else {
                printf("{\"type\":\"metrics\",\"rms\":%.3f,\"bass\":0,\"mid\":0,\"treble\":0}\n", rms);
            }
            fflush(stdout);
            fprintf(stderr, "[AUDIO] rms=%.3f bass=%.3f mid=%.3f treble=%.3f\n", rms, s_bass, s_mid, s_treble);
            sumSq = 0; count = 0;
            lastEmit = now;
        }
        // FFT debug: 1Hz dump of 7 spectrum samples + bands (minimal FFT check)
        if (now - lastDbg >= 1000) {
            lastDbg = now;
            fprintf(stderr, "[AUDIO] FFTDBG sp0=%.3f sp1=%.3f sp8=%.3f sp16=%.3f sp32=%.3f sp48=%.3f sp63=%.3f bass=%.3f mid=%.3f treble=%.3f\n",
                s_bands[0], s_bands[1], s_bands[8], s_bands[16], s_bands[32], s_bands[48], s_bands[63],
                s_bass, s_mid, s_treble);
        }
        // stdin EOF (pipe closed) -> exit
        if (GetFileType(hIn) == FILE_TYPE_PIPE) {
            DWORD avail = 0;
            if (!PeekNamedPipe(hIn, nullptr, 0, nullptr, &avail, nullptr) &&
                GetLastError() == ERROR_BROKEN_PIPE) break;
        }
        Sleep(5);
    }
    client->Stop();
    capture->Release();
    client->Release();
    return 0;
}
