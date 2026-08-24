# smtc-audio-capture.ps1
# ------------------------------------------------------------------
# Windows PROCESS LOOPBACK audio capture -> low-bandwidth AudioMetrics
# for Mineradio's external audio mode.
#
# PROTOCOL (strict, same as smtc-bridge.ps1):
#   stdout : ONLY compact JSON lines:
#     {"type":"metrics","ts":...,"rms":0.42,"bass":0.71,"mid":0.35,
#      "treble":0.58,"spectrum":[0.10,0.11,...]}          (~20/s, 50ms cap)
#     {"type":"mode","mode":"process-loopback","pid":1234}
#     {"type":"mode","mode":"system-mix-fallback","reason":"build"}
#     {"type":"sessions","active":[{"pid":1234,"name":"AppleMusic.exe"}]}
#     {"type":"pid-changed","pid":2345}
#     {"type":"ready"} / {"type":"error","code":"...","message":"...","hr":"0x..."}
#   stderr : [AUDIO] debug log lines (never mixed into stdout)
#
# Target resolution:
#   - The SMTC bridge passes the source AppUserModelId as -Aumid.
#   - This process enumerates audio sessions (IAudioSessionManager2),
#     matches the active session's process path against the AUMID and
#     activates a PROCESS LOOPBACK capture for that PID
#     (AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
#      PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE).
#   - Requires Windows 10 build 20348+. Below that, SYSTEM MIX loopback is
#     used and announced as fallback. A process-loopback failure NEVER
#     silently falls back to system mix (explicit error with HRESULT).
#
# C# is compiled at runtime via Add-Type (built-in csc.exe; no Visual
# Studio / Windows SDK needed). FFT + band analysis happen here; only
# metrics cross the pipe (no raw PCM to Electron).
# ------------------------------------------------------------------
param([string]$Aumid = '', [int]$TargetPid = 0)
#   -TargetPid <n> : skip AUMID resolution and target PID <n> directly (debug / standalone test)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Log([string]$msg) {
  try { [Console]::Error.WriteLine('[AUDIO] ' + $msg); [Console]::Error.Flush() } catch { }
}

$csCode = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace SmtcAudio
{
    // ---- WASAPI / activation COM interfaces ----
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDevice devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
        int GetDevice(string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object interfacePointer);
        int OpenPropertyStore(int access, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr waveFormat, ref Guid audioSessionGuid);
        int GetBufferSize(out uint bufferSize);
        int GetStreamLatency(out long latency);
        int GetCurrentPadding(out uint padding);
        int IsFormatSupported(int shareMode, IntPtr format, IntPtr closest);
        int GetMixFormat(out IntPtr deviceFormat);
        int GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        int GetBuffer(out IntPtr data, out uint frames, out int flags, out ulong devicePos, out ulong qpcPos);
        int ReleaseBuffer(uint frames);
        int GetNextPacketSize(out uint size);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        int GetAudioSessionControl(ref Guid sessionGuid, int streamFlags, IntPtr sid, out IntPtr session);
        int GetSimpleAudioVolume(ref Guid sessionGuid, int streamFlags, out IntPtr volume);
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        int RegisterSessionNotification(IntPtr client);
        int UnregisterSessionNotification(IntPtr client);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int idx, out IntPtr session);
    }

    [Guid("BFB7FF88-6799-4FC9-8F0B-E274D5E41E2C"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(IntPtr name, ref Guid sessionGuid);
        int GetIconPath(out IntPtr path);
        int SetIconPath(IntPtr path, ref Guid sessionGuid);
        int GetGroupingParam(out Guid grouping);
        int SetGroupingParam(ref Guid grouping, ref Guid sessionGuid);
        int RegisterAudioSessionNotification(IntPtr client);
        int UnregisterAudioSessionNotification(IntPtr client);
        int GetSessionIdentifier(out IntPtr id);
        int GetSessionInstanceIdentifier(out IntPtr id);
        int GetProcessId(out uint pid);
        int IsSystemSoundsSession(out int isSystem);
        int SetDuckingPreference(int preferToDuck);
    }

    [ComImport, Guid("41C64F90-7200-46C9-9751-63F0CCED4C86"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IntPtr activateOperation);
    }

    // Marker interface: a managed CCW implementing IAgileObject is treated as
    // agile by the CLR, so the async activation callback (raised on a thread
    // pool / MTA thread) can be marshaled into it. Without this the callback
    // is illegal from the PowerShell STA main thread -> E_ILLEGAL_METHOD_CALL.
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90")]
    interface IAgileObject { }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS
    {
        public uint TargetProcessId;
        public int ProcessLoopbackMode; // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0
    }

    [StructLayout(LayoutKind.Sequential)]
    struct AUDIOCLIENT_ACTIVATION_PARAMS
    {
        public int ActivationType;      // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
        public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MyPropVariant
    {
        public ushort vt;        // VT_BLOB = 65
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public uint cbSize;      // blob.cbSize
        public IntPtr pBlobData; // blob.pBlobData
    }

    public sealed class Capture
    {
        const int E_RENDER = 0, E_MULTIMEDIA = 1;
        const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const int AUDCLNT_SHAREMODE_SHARED = 0;
        const int CLSCTX_ALL = 23;
        const int S_OK = 0;
        const int VT_BLOB = 65;
        const int PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0;
        const int AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1;
        static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
        static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
        static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        static readonly Guid GUID_NULL = Guid.Empty;

        const int FFT_SIZE = 2048;
        const int BANDS = 64;
        // 20Hz cap: 50ms per frame (was 30ms ~= 33Hz, too much IPC pressure)
        const long EMIT_INTERVAL_TICKS = 50 * TimeSpan.TicksPerMillisecond;

        static volatile bool _running;
        static float[] _ring = new float[FFT_SIZE];
        static int _ringPos = 0;
        static double[] _fftReal = new double[FFT_SIZE];
        static double[] _fftImag = new double[FFT_SIZE];
        static long _lastEmit = 0;
        static long _lastSessionEmit = 0;
        static int _metricsCount = 0;   // for the 2Hz stderr summary line

        static IMMDeviceEnumerator _enumerator;
        static IMMDevice _device;
        static IAudioClient _client;
        static IAudioCaptureClient _capture;
        static int _channels = 2;
        static bool _float = true;
        static uint _sampleRate = 48000;
        static uint _currentTargetPid = 0;

        public static void EmitLine(string json)
        {
            try { Console.Out.WriteLine(json); Console.Out.Flush(); } catch { }
        }

        static string F(double v)
        {
            return v.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture);
        }

        static string Hex(int hr)
        {
            return "0x" + ((uint)hr).ToString("X8");
        }

        static void EmitError(string code, string message, int hr)
        {
            var sb = new StringBuilder();
            sb.Append("{\"type\":\"error\",\"code\":\"").Append(code)
              .Append("\",\"message\":\"").Append((message ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""))
              .Append("\",\"hr\":\"").Append(Hex(hr)).Append("\"}");
            EmitLine(sb.ToString());
        }

        static bool IsFiniteD(double v)
        {
            return !double.IsNaN(v) && !double.IsInfinity(v);
        }

        static void EmitMetrics(double rms, double bass, double mid, double treble, double[] bands)
        {
            // Phase 2 diagnostic: if a non-finite value ever reaches the metrics
            // stream, log it to stderr and sanitize to 0 (never emit NaN/Inf).
            bool bad = !IsFiniteD(rms) || !IsFiniteD(bass) || !IsFiniteD(mid) || !IsFiniteD(treble);
            if (!bad && bands != null)
            {
                for (int i = 0; i < bands.Length; i++)
                {
                    if (!IsFiniteD(bands[i])) { bad = true; break; }
                }
            }
            if (bad)
            {
                try
                {
                    Console.Error.WriteLine("[AUDIO] NON-FINITE METRICS DETECTED -> sanitized (rms=" + rms + " bass=" + bass + " mid=" + mid + " treble=" + treble + ")");
                    Console.Error.Flush();
                }
                catch { }
                if (!IsFiniteD(rms)) rms = 0;
                if (!IsFiniteD(bass)) bass = 0;
                if (!IsFiniteD(mid)) mid = 0;
                if (!IsFiniteD(treble)) treble = 0;
                if (bands != null) for (int i = 0; i < bands.Length; i++) if (!IsFiniteD(bands[i])) bands[i] = 0;
            }
            var sb = new StringBuilder(1024);
            sb.Append("{\"type\":\"metrics\",\"ts\":");
            sb.Append(DateTime.UtcNow.Ticks / TimeSpan.TicksPerMillisecond);
            sb.Append(",\"rms\":").Append(F(rms));
            sb.Append(",\"bass\":").Append(F(bass));
            sb.Append(",\"mid\":").Append(F(mid));
            sb.Append(",\"treble\":").Append(F(treble));
            sb.Append(",\"spectrum\":[");
            for (int i = 0; i < BANDS; i++) { if (i > 0) sb.Append(','); sb.Append(F(bands[i])); }
            sb.Append("]}");
            EmitLine(sb.ToString());
            // 2Hz stderr summary (every 10th emit at the 20Hz cap) so terminal
            // observation shows rms/bass/mid/treble changing without scrolling.
            if ((++_metricsCount % 10) == 0)
            {
                try
                {
                    Console.Error.WriteLine("[AUDIO] rms=" + F(rms) + " bass=" + F(bass) + " mid=" + F(mid) + " treble=" + F(treble));
                    Console.Error.Flush();
                }
                catch { }
            }
        }

        // Iterative radix-2 FFT (in place, real input).
        static void Fft(double[] re, double[] im)
        {
            int n = re.Length;
            for (int i = 1, j = 0; i < n; i++)
            {
                int bit = n >> 1;
                for (; (j & bit) != 0; bit >>= 1) j ^= bit;
                j ^= bit;
                if (i < j) { double tr = re[i]; re[i] = re[j]; re[j] = tr; tr = im[i]; im[i] = im[j]; im[j] = tr; }
            }
            for (int len = 2; len <= n; len <<= 1)
            {
                double ang = -2.0 * Math.PI / len;
                double wr = Math.Cos(ang), wi = Math.Sin(ang);
                for (int i = 0; i < n; i += len)
                {
                    double cr = 1, ci = 0;
                    for (int k = 0; k < len / 2; k++)
                    {
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
        }

        static void ProcessSamples(IntPtr data, uint frames)
        {
            if (_float)
            {
                int total = (int)frames * _channels;
                var buf = new byte[total * 4];
                Marshal.Copy(data, buf, 0, total * 4);
                for (uint f = 0; f < frames; f++)
                {
                    float sum = 0;
                    for (int c = 0; c < _channels; c++) sum += BitConverter.ToSingle(buf, (int)(f * _channels + c) * 4);
                    _ring[_ringPos] = sum / _channels;
                    _ringPos = (_ringPos + 1) % FFT_SIZE;
                    if (_ringPos == 0) Analyze();
                }
            }
            else
            {
                int total = (int)frames * _channels;
                var buf = new byte[total * 2];
                Marshal.Copy(data, buf, 0, total * 2);
                for (uint f = 0; f < frames; f++)
                {
                    float sum = 0;
                    for (int c = 0; c < _channels; c++) sum += BitConverter.ToInt16(buf, (int)(f * _channels + c) * 2) / 32768f;
                    _ring[_ringPos] = sum / _channels;
                    _ringPos = (_ringPos + 1) % FFT_SIZE;
                    if (_ringPos == 0) Analyze();
                }
            }
        }

        static void Analyze()
        {
            double sum = 0;
            for (int i = 0; i < FFT_SIZE; i++) { double v = _ring[i]; sum += v * v; }
            double rms = Math.Sqrt(sum / FFT_SIZE);
            if (rms > 1.0) rms = 1.0;

            for (int i = 0; i < FFT_SIZE; i++)
            {
                int idx = (_ringPos + i) % FFT_SIZE;
                double w = 0.5 - 0.5 * Math.Cos(2.0 * Math.PI * i / (FFT_SIZE - 1));
                _fftReal[i] = _ring[idx] * w;
                _fftImag[i] = 0;
            }
            Fft(_fftReal, _fftImag);

            int half = FFT_SIZE / 2;
            double[] mag = new double[half];
            double magMax = 1e-9;
            for (int i = 0; i < half; i++)
            {
                mag[i] = Math.Sqrt(_fftReal[i] * _fftReal[i] + _fftImag[i] * _fftImag[i]) / FFT_SIZE;
                if (mag[i] > magMax) magMax = mag[i];
            }

            double[] bands = new double[BANDS];
            double fMin = 20.0, fMax = Math.Min(20000.0, _sampleRate / 2.0);
            double logMin = Math.Log10(fMin), logMax = Math.Log10(fMax);
            double bandWeight = 1.0 / Math.Max(1e-6, magMax * 0.9);
            for (int b = 0; b < BANDS; b++)
            {
                double f0 = Math.Pow(10, logMin + (logMax - logMin) * b / BANDS);
                double f1 = Math.Pow(10, logMin + (logMax - logMin) * (b + 1) / BANDS);
                int bin0 = (int)(f0 * FFT_SIZE / _sampleRate);
                int bin1 = (int)Math.Ceiling(f1 * FFT_SIZE / _sampleRate);
                if (bin0 < 1) bin0 = 1;
                if (bin1 > half) bin1 = half;
                double acc = 0; int n = 0;
                for (int k = bin0; k < bin1 && k < half; k++) { acc += mag[k]; n++; }
                double v = n > 0 ? acc / n : 0;
                v = v * bandWeight;
                if (v > 1.0) v = 1.0;
                bands[b] = v;
            }

            double bass = 0, mid = 0, treble = 0;
            int bassN = Math.Max(1, BANDS * 8 / 64), midN = Math.Max(1, BANDS * 22 / 64 - BANDS * 8 / 64);
            for (int i = 0; i < BANDS * 8 / 64 && i < BANDS; i++) bass += bands[i];
            for (int i = BANDS * 8 / 64; i < BANDS * 22 / 64 && i < BANDS; i++) mid += bands[i];
            for (int i = BANDS * 22 / 64; i < BANDS; i++) treble += bands[i];
            bass /= bassN; mid /= midN; treble /= Math.Max(1, BANDS - BANDS * 22 / 64);
            if (bass > 1) bass = 1; if (mid > 1) mid = 1; if (treble > 1) treble = 1;

            long now = DateTime.UtcNow.Ticks;
            if (now - _lastEmit >= EMIT_INTERVAL_TICKS)
            {
                _lastEmit = now;
                EmitMetrics(rms, bass, mid, treble, bands);
            }
        }

        static void ReadSamples()
        {
            uint packet = 0;
            while (_running && _capture.GetNextPacketSize(out packet) == S_OK && packet > 0)
            {
                IntPtr data; uint frames; int flags; ulong devPos, qpc;
                int hr = _capture.GetBuffer(out data, out frames, out flags, out devPos, out qpc);
                if (hr != S_OK) break;
                if (frames > 0) ProcessSamples(data, frames);
                _capture.ReleaseBuffer(frames);
            }
        }

        // ---- Windows build ----
        public static int GetWindowsBuild()
        {
            try
            {
                using (var key = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
                {
                    if (key != null)
                    {
                        var v = key.GetValue("CurrentBuildNumber");
                        int b; if (v != null && int.TryParse(Convert.ToString(v), out b) && b > 0) return b;
                    }
                }
            }
            catch { }
            return 0;
        }

        // ---- Resolve target PID from the SMTC AUMID ----
        // Packaged apps: AUMID "Family_<hash>!App" -> process path contains Family.
        // Win32 apps: AUMID is often the executable path / name.
        public static uint ResolveTargetPid(string aumid, string[] outNames)
        {
            aumid = (aumid ?? "").Trim();
            if (aumid.Length == 0) return 0;
            bool isExe = aumid.IndexOf(".exe", StringComparison.OrdinalIgnoreCase) >= 0 || aumid.IndexOf('\\') >= 0 || aumid.IndexOf('/') >= 0;
            string exeName = null, family = null, familyWithHash = null, familyLastSegment = null;
            if (isExe) { exeName = System.IO.Path.GetFileName(aumid); }
            else
            {
                int bang = aumid.IndexOf('!');
                familyWithHash = bang > 0 ? aumid.Substring(0, bang) : aumid;
                family = familyWithHash;
                int lastUnderscore = familyWithHash.LastIndexOf('_');
                if (lastUnderscore > 0)
                {
                    string tail = familyWithHash.Substring(lastUnderscore + 1);
                    if (tail.Length >= 4 && tail.Length <= 20 && IsLowerAlphaNum(tail)) family = familyWithHash.Substring(0, lastUnderscore);
                }
                int lastDot = family.LastIndexOf('.');
                familyLastSegment = lastDot >= 0 ? family.Substring(lastDot + 1) : family;
            }

            uint best = 0; int bestScore = -1; string bestName = null;
            try
            {
                foreach (var p in System.Diagnostics.Process.GetProcesses())
                {
                    string path = "", name = "";
                    try { name = p.ProcessName; } catch { continue; }
                    try { path = p.MainModule != null ? (p.MainModule.FileName ?? "") : ""; } catch { }
                    int score = 0;
                    if (exeName != null)
                    {
                        string baseName = System.IO.Path.GetFileNameWithoutExtension(exeName);
                        if (baseName.Length > 0)
                        {
                            if (name.Equals(baseName, StringComparison.OrdinalIgnoreCase)) score = 3;
                            else if (path.IndexOf(exeName, StringComparison.OrdinalIgnoreCase) >= 0) score = 3;
                            else if (name.IndexOf(baseName, StringComparison.OrdinalIgnoreCase) >= 0) score = 2;
                        }
                    }
                    else if (family != null && family.Length > 0)
                    {
                        if (path.IndexOf(family, StringComparison.OrdinalIgnoreCase) >= 0) score = 3;
                        else if (familyWithHash != null && familyWithHash.Length > 0 && path.IndexOf(familyWithHash, StringComparison.OrdinalIgnoreCase) >= 0) score = 2;
                        // Prefer the main process: its name is usually a prefix of the
                        // family's last segment (AppleMusic is a prefix of AppleMusicWin)
                        // while helper processes (AMPLibraryAgent etc.) are not.
                        if (score > 0 && familyLastSegment != null && familyLastSegment.Length > 0 &&
                            name.Length <= familyLastSegment.Length && familyLastSegment.StartsWith(name, StringComparison.OrdinalIgnoreCase))
                        {
                            score += 2;
                        }
                    }
                    if (score > 0 && score > bestScore)
                    {
                        bestScore = score;
                        best = (uint)p.Id;
                        bestName = name;
                    }
                }
            }
            catch { }
            if (outNames != null && bestName != null) outNames[0] = bestName + ".exe";
            return best;
        }

        static bool IsLowerAlphaNum(string s)
        {
            if (s == null || s.Length == 0) return false;
            foreach (char c in s) { if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false; }
            return true;
        }

        // ---- Process loopback activation ----
        // ActivateAudioInterfaceAsync is exported by mmdevapi.dll on modern
        // Windows (combase.dll on some builds). Try mmdevapi first.
        [DllImport("mmdevapi.dll", EntryPoint = "ActivateAudioInterfaceAsync", PreserveSig = true)]
        static extern int ActivateAudioInterfaceAsyncMmdev(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            ref Guid riid,
            IntPtr activationParams,
            IntPtr completionHandler,
            out IntPtr activationOperation);

        [DllImport("combase.dll", EntryPoint = "ActivateAudioInterfaceAsync", PreserveSig = true)]
        static extern int ActivateAudioInterfaceAsyncCombase(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            ref Guid riid,
            IntPtr activationParams,
            IntPtr completionHandler,
            out IntPtr activationOperation);

        static int ActivateAudioInterfaceAsyncAny(string deviceInterfacePath, ref Guid riid, IntPtr activationParams, IntPtr completionHandler, out IntPtr activationOperation)
        {
            activationOperation = IntPtr.Zero;
            try { return ActivateAudioInterfaceAsyncMmdev(deviceInterfacePath, ref riid, activationParams, completionHandler, out activationOperation); }
            catch (EntryPointNotFoundException) { }
            catch (DllNotFoundException) { }
            return ActivateAudioInterfaceAsyncCombase(deviceInterfacePath, ref riid, activationParams, completionHandler, out activationOperation);
        }

        class ActivationHandler : IAgileObject, IActivateAudioInterfaceCompletionHandler
        {
            public readonly ManualResetEvent Done = new ManualResetEvent(false);
            public int Hr = unchecked((int)0x80004005);
            public IAudioClient Client;
            public string Error = "";
            public int ActivateCompleted(IntPtr op)
            {
                // Minimal-activation-test hook: proves the async callback entered.
                try { Console.Error.WriteLine("[AUDIO] activation callback entered"); Console.Error.Flush(); } catch { }
                try
                {
                    var operation = (IActivateAudioInterfaceAsyncOperation)Marshal.GetObjectForIUnknown(op);
                    object iface;
                    int r = operation.GetActivateResult(out Hr, out iface);
                    // Target log: always report the activation RESULT, success or not.
                    try { Console.Error.WriteLine("[AUDIO] activation result hr=" + Hex(Hr) + " (get=" + Hex(r) + ")"); Console.Error.Flush(); } catch { }
                    if (r == S_OK && Hr == S_OK && iface != null) Client = (IAudioClient)iface;
                }
                catch (Exception ex) { Hr = unchecked((int)0x80004005); Error = ex.Message; }
                finally { try { Done.Set(); } catch { } }
                return S_OK;
            }
        }

        static int ActivateProcessLoopbackClient(uint pid, out IAudioClient client)
        {
            client = null;
            int hr = 0;
            // Process loopback MUST activate the virtual loopback device, not a
            // real endpoint path (official ApplicationLoopbackAudioCapture sample).
            const string VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = @"\\?\VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK";

            var activationParams = new AUDIOCLIENT_ACTIVATION_PARAMS();
            activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
            activationParams.ProcessLoopbackParams.TargetProcessId = pid;
            activationParams.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

            IntPtr blob = Marshal.AllocHGlobal(Marshal.SizeOf(activationParams));
            Marshal.StructureToPtr(activationParams, blob, false);
            var pv = new MyPropVariant();
            pv.vt = VT_BLOB;
            pv.cbSize = (uint)Marshal.SizeOf(activationParams);
            pv.pBlobData = blob;
            IntPtr pvPtr = Marshal.AllocHGlobal(Marshal.SizeOf(pv));
            Marshal.StructureToPtr(pv, pvPtr, false);

            var handler = new ActivationHandler();
            IntPtr handlerPtr = IntPtr.Zero;
            try
            {
                handlerPtr = Marshal.GetComInterfaceForObject(handler, typeof(IActivateAudioInterfaceCompletionHandler));
                var iidClient = IID_IAudioClient;
                IntPtr op;
                // Runtime evidence of exactly what we pass to the native API.
                try { Console.Error.WriteLine("[AUDIO] activating pid=" + pid + " cbSize=" + pv.cbSize + " path=" + VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK + " pvSize=" + Marshal.SizeOf(pv)); Console.Error.Flush(); } catch { }
                hr = ActivateAudioInterfaceAsyncAny(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, ref iidClient, pvPtr, handlerPtr, out op);
                try { Console.Error.WriteLine("[AUDIO] ActivateAudioInterfaceAsync hr=" + Hex(hr)); Console.Error.Flush(); } catch { }
                if (hr != S_OK) return hr;
                handler.Done.WaitOne(8000);
                hr = handler.Hr;
                client = handler.Client;
                return hr;
            }
            finally
            {
                if (blob != IntPtr.Zero) Marshal.FreeHGlobal(blob);
                if (pvPtr != IntPtr.Zero) Marshal.FreeHGlobal(pvPtr);
                // handlerPtr intentionally leaked: the async activation may still
                // reference the CCW; the process lives for the app session.
            }
        }

        static int SetupCapture(IAudioClient client)
        {
            _client = client;
            IntPtr mix = IntPtr.Zero;
            int hr = _client.GetMixFormat(out mix);
            if (hr != S_OK) return hr;
            ushort tag = (ushort)Marshal.ReadInt16(mix, 0);
            ushort bits = (ushort)Marshal.ReadInt16(mix, 14);
            ushort cbSize = (ushort)Marshal.ReadInt16(mix, 16);
            _sampleRate = (uint)Marshal.ReadInt32(mix, 4);
            _channels = (ushort)Marshal.ReadInt16(mix, 2);
            if (_channels < 1) _channels = 2;
            if (tag == 0xFFFE && cbSize >= 22)
            {
                uint sub = (uint)Marshal.ReadInt32(mix, 24);
                _float = (sub == 3);
            }
            else _float = (tag == 3);

            var iidNull = GUID_NULL;
            hr = _client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 0, 0, mix, ref iidNull);
            if (hr != S_OK) return hr;

            object o;
            var iidCapture = IID_IAudioCaptureClient;
            hr = _client.GetService(ref iidCapture, out o);
            if (hr != S_OK) return hr;
            _capture = (IAudioCaptureClient)o;

            _running = true;
            _lastEmit = DateTime.UtcNow.Ticks;
            _lastSessionEmit = 0;
            return S_OK;
        }

        static int RunCapture()
        {
            var sessionThread = new Thread(SessionLoop);
            sessionThread.IsBackground = true;
            sessionThread.Start();
            int hr = _client.Start();
            if (hr != S_OK) { _running = false; return hr; }
            try { Console.Error.WriteLine("[AUDIO] PCM capture started"); Console.Error.Flush(); } catch { }
            while (_running)
            {
                ReadSamples();
                Thread.Sleep(2);
            }
            return S_OK;
        }

        // ---- Public entry points ----
        public static int StartProcessLoopback(uint pid)
        {
            _currentTargetPid = pid;
            IAudioClient client;
            int hr = ActivateProcessLoopbackClient(pid, out client);
            if (hr != S_OK)
            {
                EmitError("PROCESS_LOOPBACK_ACTIVATE_FAILED", "ActivateAudioInterfaceAsync failed", hr);
                return 1;
            }
            // Minimal-activation-test gate: callback entered + IAudioClient
            // returned -> only now create the capture client and start PCM.
            try { Console.Error.WriteLine("[AUDIO] process loopback activated"); Console.Error.Flush(); } catch { }
            hr = SetupCapture(client);
            if (hr != S_OK)
            {
                EmitError("PROCESS_LOOPBACK_INIT_FAILED", "Initialize/GetService failed", hr);
                return 1;
            }
            EmitLine("{\"type\":\"mode\",\"mode\":\"process-loopback\",\"pid\":" + pid + "}");
            EmitLine("{\"type\":\"ready\"}");
            return RunCapture();
        }

        public static int StartSystemMix()
        {
            object o;
            var iidClient = IID_IAudioClient;
            int hr = _device.Activate(ref iidClient, CLSCTX_ALL, IntPtr.Zero, out o);
            if (hr != S_OK) { EmitError("SYSTEM_MIX_ACTIVATE_FAILED", "IAudioClient activate failed", hr); return 1; }
            hr = SetupCapture((IAudioClient)o);
            if (hr != S_OK) { EmitError("SYSTEM_MIX_INIT_FAILED", "Initialize/GetService failed", hr); return 1; }
            EmitLine("{\"type\":\"mode\",\"mode\":\"system-mix-fallback\",\"reason\":\"build\"}");
            EmitLine("{\"type\":\"ready\"}");
            return RunCapture();
        }

        public static int InitEnumerator()
        {
            _enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice dev;
            int hr = _enumerator.GetDefaultAudioEndpoint(E_RENDER, E_MULTIMEDIA, out dev);
            if (hr != S_OK) return hr;
            _device = dev;
            return S_OK;
        }

        static void SessionLoop()
        {
            while (_running)
            {
                try
                {
                    long now = DateTime.UtcNow.Ticks;
                    if (now - _lastSessionEmit < 2500 * TimeSpan.TicksPerMillisecond) { Thread.Sleep(500); continue; }
                    _lastSessionEmit = now;
                    var names = new string[1];
                    uint pid = ResolveTargetPid(Environment.GetEnvironmentVariable("SMTC_AUMID") ?? "", names);
                    if (pid != 0 && pid != _currentTargetPid)
                    {
                        EmitLine("{\"type\":\"pid-changed\",\"pid\":" + pid + "}");
                    }
                }
                catch { }
                Thread.Sleep(500);
            }
        }
    }
}
'@

# ---- compile C# at runtime (built-in csc, no VS needed) ----
$compileOk = $false
try {
  Add-Type -TypeDefinition $csCode -Language CSharp -ErrorAction Stop
  $compileOk = $true
  Log 'C# compiled OK'
} catch {
  Log ('Add-Type failed: ' + $_.Exception.Message)
  try { [Console]::Out.WriteLine('{"type":"error","code":"COMPILE_FAILED","message":"Add-Type compile failed"}'); [Console]::Out.Flush() } catch { }
}

if ($compileOk) {
  [Environment]::SetEnvironmentVariable('SMTC_AUMID', $Aumid, 'Process')
  $build = [SmtcAudio.Capture]::GetWindowsBuild()
  Log ('Windows build: ' + $build + ' | AUMID: ' + $Aumid + ' | TargetPid: ' + $TargetPid)

  if ($build -ge 20348) {
    # NOTE: never name a local variable $targetPid - PowerShell is
    # case-insensitive and it would clobber the $TargetPid parameter.
    # Process loopback needs no default render endpoint (virtual device path).
    # Resolve the target: -TargetPid wins; otherwise resolve from the AUMID.
    $resolvedPid = 0
    $targetName = ''
    if ($TargetPid -gt 0) {
      $resolvedPid = [uint32]$TargetPid
      try { $targetName = (Get-Process -Id $TargetPid -ErrorAction Stop).ProcessName } catch { $targetName = '' }
      Log ('target pid (direct): ' + $resolvedPid + ' name: ' + $targetName)
    } else {
      $nameArr = New-Object string[] 1
      $resolvedPid = [SmtcAudio.Capture]::ResolveTargetPid($Aumid, $nameArr)
      if ($resolvedPid -eq 0) {
        Log 'pid resolution failed'
        try { [Console]::Out.WriteLine('{"type":"error","code":"PID_RESOLVE_FAILED","message":"cannot resolve target process for AUMID: ' + ($Aumid -replace '"','') + '"}'); [Console]::Out.Flush() } catch { }
        exit 1
      }
      Log ('target pid: ' + $resolvedPid + ' name: ' + ($nameArr[0] -join ''))
    }
    $rc = 1
    try {
      $rc = [SmtcAudio.Capture]::StartProcessLoopback($resolvedPid)
    } catch {
      Log ('StartProcessLoopback exception: ' + $_.Exception.ToString())
      try { [Console]::Out.WriteLine('{"type":"error","code":"PROCESS_LOOPBACK_EXCEPTION","message":"' + ($_.Exception.Message -replace '"','') + '"}'); [Console]::Out.Flush() } catch { }
    }
    # Activation/init failure -> stop immediately (minimal activation test):
    # do NOT fall through to anything else on a failed activation.
    if ($rc -ne 0) { Log ('process loopback failed rc=' + $rc); exit 1 }
  } else {
    $initHr = [SmtcAudio.Capture]::InitEnumerator()
    if ($initHr -ne 0) {
      Log ('endpoint init failed: 0x' + $initHr.ToString('X8'))
      try { [Console]::Out.WriteLine('{"type":"error","code":"ENDPOINT_FAILED","message":"default render endpoint unavailable","hr":"0x' + $initHr.ToString('X8') + '"}'); [Console]::Out.Flush() } catch { }
      exit 1
    }
    Log ('process loopback unsupported on build ' + $build + ', using system mix fallback')
    try { [SmtcAudio.Capture]::StartSystemMix() | Out-Null } catch { Log ('StartSystemMix exception: ' + $_.Exception.Message) }
  }
}

try { while ($true) { Start-Sleep -Milliseconds 500 } } catch { }
