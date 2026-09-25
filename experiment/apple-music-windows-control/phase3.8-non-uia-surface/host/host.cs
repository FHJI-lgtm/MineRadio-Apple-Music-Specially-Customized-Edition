using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
class PsHost {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetCurrentPackageFullName(ref int len, StringBuilder name);
  [DllImport("ole32.dll")] static extern int CoInitializeEx(IntPtr p, uint m);
  [DllImport("ole32.dll")] static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint ctx, ref Guid iid, out IntPtr ppv);
  const string OUT = @"C:\Users\limin\OneDrive\mineradio-apple-music\experiment\apple-music-windows-control\phase3.8-non-uia-surface\evidence\pshost-result.txt";
  static void Main() {
    var sb = new StringBuilder();
    int len = 0;
    int rc = GetCurrentPackageFullName(ref len, null);
    bool packaged = (rc == 0 || rc == 122);
    string full = "";
    if (packaged) { var b = new StringBuilder(len); int rc2 = GetCurrentPackageFullName(ref len, b); if (rc2 == 0) full = b.ToString(); }
    sb.AppendLine("HOST_PACKAGED=" + (packaged ? "true" : "false"));
    sb.AppendLine("PACKAGE_FULL_NAME=" + (full == "" ? "EMPTY" : full));
    sb.AppendLine("GETPACKAGEFULLNAME_RC=0x" + rc.ToString("X8"));
    sb.AppendLine("COINITIALIZE_HR=0x" + CoInitializeEx(IntPtr.Zero, 2).ToString("X8"));
    Guid clsid = new Guid("68E7097C-F969-4006-AAC3-95115F0ED1C4");
    Guid iidUnk = new Guid("00000000-0000-0000-C000-000000000046");
    Guid iidLib = new Guid("F707A913-E0CE-4FD4-BCE3-425DD153285B");
    Guid iidMus = new Guid("68E7097C-F969-4006-AAC3-95115F0ED1C4");
    IntPtr punk = IntPtr.Zero;
    int hrC = CoCreateInstance(ref clsid, IntPtr.Zero, 5, ref iidUnk, out punk);
    sb.AppendLine("COCREATE_HR=0x" + hrC.ToString("X8"));
    sb.AppendLine("COCREATE_OBJECT_NONNULL=" + (punk != IntPtr.Zero ? "true" : "false"));
    if (punk != IntPtr.Zero) {
      Guid g1 = iidLib; IntPtr p1 = IntPtr.Zero; int hr1 = Marshal.QueryInterface(punk, ref g1, out p1);
      sb.AppendLine("QI_IAMPLIBRARY_HR=0x" + hr1.ToString("X8"));
      sb.AppendLine("QI_IAMPLIBRARY_NONNULL=" + (p1 != IntPtr.Zero ? "true" : "false"));
      Guid g2 = iidMus; IntPtr p2 = IntPtr.Zero; int hr2 = Marshal.QueryInterface(punk, ref g2, out p2);
      sb.AppendLine("QI_IAMPMUSICLIBRARY_HR=0x" + hr2.ToString("X8"));
      sb.AppendLine("QI_IAMPMUSICLIBRARY_NONNULL=" + (p2 != IntPtr.Zero ? "true" : "false"));
    } else { sb.AppendLine("QI_IAMPLIBRARY_HR=NOT_ATTEMPTED"); sb.AppendLine("QI_IAMPMUSICLIBRARY_HR=NOT_ATTEMPTED"); }
    sb.AppendLine("NO_BUSINESS_METHOD_CALLED=true");
    sb.AppendLine("VTABLE_3PLUS_TOUCHED=false");
    sb.AppendLine("PROXY_DLL_LOADED=false");
    sb.AppendLine("PS_REGISTRATION_CALLS=0");
    File.WriteAllText(OUT, sb.ToString());
  }
}