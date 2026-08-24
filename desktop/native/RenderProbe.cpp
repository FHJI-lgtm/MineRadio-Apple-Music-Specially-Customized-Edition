// RenderProbe.cpp - prove the machine's audio engine end-to-end: render a
// 2s sine wave to the default endpoint AND capture it via system-mix loopback
// in the same process. If packets are captured, render+capture work.
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

int wmain() {
    printf("=== RenderProbe: render + loopback capture ===\n");
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    printf("CoInitializeEx = 0x%08X\n", (unsigned)hr);
    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator_, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator_, (void**)&enumerator);
    if (FAILED(hr)) { printf("no enumerator\n"); return 1; }
    IMMDevice* def = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &def);
    printf("GetDefaultAudioEndpoint = 0x%08X\n", (unsigned)hr);
    if (FAILED(hr) || !def) return 1;

    IAudioClient* capClient = nullptr;
    hr = def->Activate(IID_IAudioClient_, CLSCTX_ALL, nullptr, (void**)&capClient);
    printf("Activate(capture client) = 0x%08X\n", (unsigned)hr);
    WAVEFORMATEX* mix = nullptr;
    if (SUCCEEDED(hr)) hr = capClient->GetMixFormat(&mix);
    printf("GetMixFormat = 0x%08X (sr=%u ch=%u)\n", (unsigned)hr, mix ? mix->nSamplesPerSec : 0, mix ? mix->nChannels : 0);
    if (FAILED(hr) || !mix) return 1;

    // capture client (loopback)
    hr = capClient->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 0, 0, mix, nullptr);
    printf("capture Initialize(LOOPBACK) = 0x%08X\n", (unsigned)hr);
    IAudioCaptureClient* cap = nullptr;
    if (SUCCEEDED(hr)) hr = capClient->GetService(IID_IAudioCaptureClient_, (void**)&cap);
    printf("capture GetService = 0x%08X\n", (unsigned)hr);
    if (SUCCEEDED(hr)) hr = capClient->Start();
    printf("capture Start = 0x%08X\n", (unsigned)hr);

    // render client (same device, same format) - 2s sine at 440Hz
    IAudioClient* renClient = nullptr;
    hr = def->Activate(IID_IAudioClient_, CLSCTX_ALL, nullptr, (void**)&renClient);
    printf("render Activate = 0x%08X\n", (unsigned)hr);
    if (SUCCEEDED(hr)) hr = renClient->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1000000, 0, mix, nullptr);
    printf("render Initialize = 0x%08X\n", (unsigned)hr);
    IAudioRenderClient* ren = nullptr;
    if (SUCCEEDED(hr)) hr = renClient->GetService(IID_IAudioRenderClient_, (void**)&ren);
    printf("render GetService = 0x%08X\n", (unsigned)hr);
    UINT32 bufFrames = 0;
    if (SUCCEEDED(hr)) renClient->GetBufferSize(&bufFrames);
    printf("render buffer frames = %u\n", bufFrames);
    if (SUCCEEDED(hr)) {
        BYTE* dataPtr = nullptr;
        hr = ren->GetBuffer(bufFrames, &dataPtr);
        if (SUCCEEDED(hr) && dataPtr) {
            float* data = (float*)dataPtr;
            for (UINT32 f = 0; f < bufFrames; f++) {
                float v = (float)(0.25 * sin(2.0 * 3.14159 * 440.0 * f / mix->nSamplesPerSec));
                for (WORD c = 0; c < mix->nChannels; c++) data[f * mix->nChannels + c] = v;
            }
            ren->ReleaseBuffer(bufFrames, 0);
        }
        hr = renClient->Start();
        printf("render Start = 0x%08X\n", (unsigned)hr);
    }
    CoTaskMemFree(mix);

    // capture 2.5s while rendering
    printf("capturing 2.5s (render active)...\n");
    uint64_t packets = 0, frames = 0;
    ULONGLONG t0 = GetTickCount64();
    while (GetTickCount64() - t0 < 2500) {
        UINT32 packet = 0;
        while (cap && cap->GetNextPacketSize(&packet) == S_OK && packet > 0) {
            BYTE* data = nullptr; UINT32 f = 0; DWORD flags = 0; UINT64 dp = 0, qp = 0;
            if (SUCCEEDED(cap->GetBuffer(&data, &f, &flags, &dp, &qp))) { packets++; frames += f; }
            cap->ReleaseBuffer(f);
        }
        Sleep(5);
    }
    printf("captured: packets=%llu frames=%llu\n", (unsigned long long)packets, (unsigned long long)frames);
    printf("=== done ===\n");
    return 0;
}
