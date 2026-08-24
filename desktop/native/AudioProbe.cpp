// AudioProbe.cpp — machine audio-stack probe (no process loopback).
// Answers: does this machine have an active render endpoint, and can a plain
// system-mix loopback capture run at all? Use plain COM (no WRL/WIL).
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

int wmain() {
    printf("=== AudioProbe ===\n");
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    printf("CoInitializeEx = 0x%08X\n", (unsigned)hr);
    IMMDeviceEnumerator* enumerator = nullptr;
    hr = CoCreateInstance(CLSID_MMDeviceEnumerator_, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator_, (void**)&enumerator);
    printf("CoCreateInstance(MMDeviceEnumerator) = 0x%08X\n", (unsigned)hr);
    if (FAILED(hr)) return 1;

    IMMDeviceCollection* coll = nullptr;
    hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &coll);
    printf("EnumAudioEndpoints(render, active) = 0x%08X\n", (unsigned)hr);
    UINT count = 0;
    if (SUCCEEDED(hr) && coll) {
        coll->GetCount(&count);
        printf("active render endpoints = %u\n", count);
        for (UINT i = 0; i < count && i < 8; i++) {
            IMMDevice* dev = nullptr;
            if (SUCCEEDED(coll->Item(i, &dev)) && dev) {
                LPWSTR id = nullptr;
                if (SUCCEEDED(dev->GetId(&id))) { printf("  [%u] id=%ls\n", i, id ? id : L"?"); if (id) CoTaskMemFree(id); }
                dev->Release();
            }
        }
        coll->Release();
    }

    IMMDevice* def = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &def);
    printf("GetDefaultAudioEndpoint(render) = 0x%08X\n", (unsigned)hr);
    if (SUCCEEDED(hr) && def) {
        IAudioClient* client = nullptr;
        hr = def->Activate(IID_IAudioClient_, CLSCTX_ALL, nullptr, (void**)&client);
        printf("Activate(IAudioClient) = 0x%08X\n", (unsigned)hr);
        if (SUCCEEDED(hr) && client) {
            WAVEFORMATEX* mix = nullptr;
            hr = client->GetMixFormat(&mix);
            bool isFloat = false;
            if (SUCCEEDED(hr) && mix) {
                isFloat = (mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT);
                if (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE && mix->cbSize >= 22) {
                    WAVEFORMATEXTENSIBLE* ext = (WAVEFORMATEXTENSIBLE*)mix;
                    isFloat = (*(const DWORD*)&ext->SubFormat == 3);
                }
                printf("GetMixFormat = 0x%08X (sr=%u ch=%u tag=%u float=%d)\n",
                    (unsigned)hr, mix->nSamplesPerSec, mix->nChannels, mix->wFormatTag, isFloat ? 1 : 0);
                hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 0, 0, mix, nullptr);
                printf("Initialize(LOOPBACK shared) = 0x%08X\n", (unsigned)hr);
                CoTaskMemFree(mix);
                if (SUCCEEDED(hr)) {
                    IAudioCaptureClient* cap = nullptr;
                    hr = client->GetService(IID_IAudioCaptureClient_, (void**)&cap);
                    printf("GetService(IAudioCaptureClient) = 0x%08X\n", (unsigned)hr);
                    if (SUCCEEDED(hr) && cap) {
                        hr = client->Start();
                        printf("Start = 0x%08X\n", (unsigned)hr);
                        if (SUCCEEDED(hr)) {
                            printf("capturing 2s...\n");
                            uint64_t totalFrames = 0, packets = 0;
                            double sumSq = 0;
                            ULONGLONG t0 = GetTickCount64();
                            while (GetTickCount64() - t0 < 2000) {
                                UINT32 packet = 0;
                                while (cap->GetNextPacketSize(&packet) == S_OK && packet > 0) {
                                    BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0; UINT64 dp = 0, qp = 0;
                                    HRESULT hr2 = cap->GetBuffer(&data, &frames, &flags, &dp, &qp);
                                    if (SUCCEEDED(hr2) && frames > 0 && data) {
                                        packets++;
                                        totalFrames += frames;
                                        if (isFloat) {
                                            const float* p = (const float*)data;
                                            for (UINT32 f = 0; f < frames && f < 64; f++) { float v = p[f]; sumSq += (double)v * v; }
                                        }
                                    }
                                    cap->ReleaseBuffer(frames);
                                }
                                Sleep(2);
                            }
                            double rms = sumSq > 0 ? sqrt(sumSq / (packets > 0 ? packets * 64 : 1)) : 0;
                            printf("captured: packets=%llu frames=%llu rms-sample=%f\n", (unsigned long long)packets, (unsigned long long)totalFrames, rms);
                        }
                    }
                }
            }
        }
        def->Release();
    }
    printf("=== done ===\n");
    return 0;
}
