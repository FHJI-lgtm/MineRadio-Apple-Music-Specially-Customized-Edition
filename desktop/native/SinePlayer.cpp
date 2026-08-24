// SinePlayer.cpp - render a continuous 440Hz sine to the default endpoint.
// Used to verify process-loopback capture of an actively-rendering process.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <stdio.h>
#include <math.h>

static const GUID CLSID_MMDeviceEnumerator_ = { 0xBCDE0395, 0xE52F, 0x467C, { 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E } };
static const GUID IID_IMMDeviceEnumerator_ = { 0xA95664D2, 0x9614, 0x4F35, { 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6 } };
static const GUID IID_IAudioClient_ = { 0x1CB9AD4C, 0xDBFA, 0x4c32, { 0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2 } };
static const GUID IID_IAudioRenderClient_ = { 0xF294ACFC, 0x3146, 0x4483, { 0xA7, 0xBF, 0xAD, 0xDC, 0xA7, 0xC2, 0x60, 0xE2 } };

int wmain() {
    printf("SinePlayer pid=%lu started\n", (unsigned long)GetCurrentProcessId());
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    IMMDeviceEnumerator* e = nullptr;
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator_, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator_, (void**)&e);
    IMMDevice* def = nullptr;
    hr = e->GetDefaultAudioEndpoint(eRender, eMultimedia, &def);
    IAudioClient* ac = nullptr;
    hr = def->Activate(IID_IAudioClient_, CLSCTX_ALL, nullptr, (void**)&ac);
    WAVEFORMATEX* mix = nullptr;
    hr = ac->GetMixFormat(&mix);
    DWORD sr = mix->nSamplesPerSec; WORD ch = mix->nChannels;
    hr = ac->Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 500000, 0, mix, nullptr);
    IAudioRenderClient* rc = nullptr;
    hr = ac->GetService(IID_IAudioRenderClient_, (void**)&rc);
    UINT32 frames = 0;
    ac->GetBufferSize(&frames);
    // pre-fill several buffers of sine
    double phase = 0;
    for (int fill = 0; fill < 6; fill++) {
        BYTE* dp = nullptr;
        if (SUCCEEDED(rc->GetBuffer(frames, &dp)) && dp) {
            float* data = (float*)dp;
            for (UINT32 f = 0; f < frames; f++) {
                float v = (float)(0.4 * sin(phase));
                phase += 2.0 * 3.14159 * 440.0 / sr;
                for (WORD c = 0; c < ch; c++) data[f * ch + c] = v;
            }
            rc->ReleaseBuffer(frames, 0);
        }
    }
    hr = ac->Start();
    printf("SinePlayer render started hr=0x%08X (sr=%u ch=%u)\n", (unsigned)hr, sr, ch);
    // continuous render pump: keep refilling so the stream never underruns
    double phase2 = phase;
    while (true) {
        UINT32 pad = 0;
        ac->GetCurrentPadding(&pad);
        UINT32 avail = frames - pad;
        if (avail > 0) {
            BYTE* dp = nullptr;
            if (SUCCEEDED(rc->GetBuffer(avail, &dp)) && dp) {
                float* data = (float*)dp;
                for (UINT32 f = 0; f < avail; f++) {
                    float v = (float)(0.4 * sin(phase2));
                    phase2 += 2.0 * 3.14159 * 440.0 / sr;
                    for (WORD c = 0; c < ch; c++) data[f * ch + c] = v;
                }
                rc->ReleaseBuffer(avail, 0);
            }
        }
        Sleep(10);
    }
    return 0;
}
