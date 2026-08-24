using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace NetOps.Remote
{
    public static class Program
    {
        [DllImport("user32.dll")]
        public static extern bool SetCursorPos(int x, int y);

        [DllImport("user32.dll")]
        public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        [DllImport("user32.dll")]
        public static extern bool LockWorkStation();

        [DllImport("user32.dll")]
        public static extern IntPtr GetDesktopWindow();

        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr hDC);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int nWidth, int nHeight);

        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);

        [DllImport("gdi32.dll")]
        public static extern bool BitBlt(IntPtr hObject, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hObjectSource, int nXSrc, int nYSrc, int dwRop);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr hDC);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr hObject);

        public const int SRCCOPY = 0x00CC0020;

        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;

        public const byte VK_LWIN = 0x5B;
        public const byte VK_CONTROL = 0x11;
        public const byte VK_SHIFT = 0x10;
        public const byte VK_MENU = 0x12; // Alt
        public const byte VK_TAB = 0x09;
        public const byte VK_ESCAPE = 0x1B;
        public const byte VK_RETURN = 0x0D;
        public const byte VK_BACK = 0x08;
        public const byte VK_D = 0x44;

        public const uint KEYEVENTF_KEYUP = 0x0002;

        private static TcpListener _listener;
        private static volatile bool _running = true;

        public static void Main(string[] args)
        {
            int port = 3002;
            if (args.Length >= 1) int.TryParse(args[0], out port);

            try
            {
                _listener = new TcpListener(IPAddress.Loopback, port);
                _listener.Start();
                Console.WriteLine("NETOPS_REMOTE_READY:" + port);

                while (_running)
                {
                    TcpClient client = _listener.AcceptTcpClient();
                    ThreadPool.QueueUserWorkItem(HandleClient, client);
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine("NETOPS_REMOTE_ERR:" + ex.Message);
            }
        }

        private static Bitmap CaptureScreenBitBlt(int w, int h)
        {
            IntPtr hdcSrc = GetDC(IntPtr.Zero);
            IntPtr hdcDest = CreateCompatibleDC(hdcSrc);
            IntPtr hBitmap = CreateCompatibleBitmap(hdcSrc, w, h);
            IntPtr hOld = SelectObject(hdcDest, hBitmap);

            BitBlt(hdcDest, 0, 0, w, h, hdcSrc, 0, 0, SRCCOPY);
            SelectObject(hdcDest, hOld);
            DeleteDC(hdcDest);
            ReleaseDC(IntPtr.Zero, hdcSrc);

            Bitmap bmp = Image.FromHbitmap(hBitmap);
            DeleteObject(hBitmap);
            return bmp;
        }

        private static void HandleClient(object state)
        {
            TcpClient client = (TcpClient)state;
            client.NoDelay = true;
            client.SendBufferSize = 1024 * 1024;
            NetworkStream stream = client.GetStream();

            int targetWidth = 960;
            int targetHeight = 540;
            int quality = 60;
            int fps = 20;

            // 启动命令读取线程
            Thread readThread = new Thread(() =>
            {
                try
                {
                    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                    {
                        string line;
                        while (client.Connected && (line = reader.ReadLine()) != null)
                        {
                            try
                            {
                                string cmd = line.Trim();
                                if (cmd.StartsWith("CONFIG:"))
                                {
                                    string[] cfg = cmd.Substring(7).Split(':');
                                    if (cfg.Length >= 1) int.TryParse(cfg[0], out targetWidth);
                                    if (cfg.Length >= 2) int.TryParse(cfg[1], out targetHeight);
                                    if (cfg.Length >= 3) int.TryParse(cfg[2], out quality);
                                    if (cfg.Length >= 4) int.TryParse(cfg[3], out fps);
                                }
                                else
                                {
                                    HandleCommand(cmd);
                                }
                            }
                            catch { }
                        }
                    }
                }
                catch { }
            })
            { IsBackground = true };
            readThread.Start();

            Rectangle bounds = Screen.PrimaryScreen.Bounds;
            byte[] initHeader = Encoding.UTF8.GetBytes(string.Format("INIT:{0}:{1}\n", bounds.Width, bounds.Height));
            try
            {
                stream.Write(initHeader, 0, initHeader.Length);
                stream.Flush();
            }
            catch { return; }

            ImageCodecInfo jpgEncoder = GetEncoder(ImageFormat.Jpeg);
            EncoderParameters encParams = new EncoderParameters(1);
            encParams.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);

            while (client.Connected)
            {
                long startTick = Environment.TickCount;
                int delayMs = Math.Max(10, 1000 / Math.Max(1, fps));

                try
                {
                    bounds = Screen.PrimaryScreen.Bounds;
                    using (Bitmap screenBmp = CaptureScreenBitBlt(bounds.Width, bounds.Height))
                    {
                        int outW = targetWidth > 0 && targetWidth < bounds.Width ? targetWidth : bounds.Width;
                        int outH = targetHeight > 0 && targetHeight < bounds.Height ? targetHeight : bounds.Height;

                        using (Bitmap outBmp = new Bitmap(outW, outH, PixelFormat.Format24bppRgb))
                        {
                            using (Graphics gOut = Graphics.FromImage(outBmp))
                            {
                                gOut.InterpolationMode = InterpolationMode.Low;
                                gOut.DrawImage(screenBmp, 0, 0, outW, outH);
                            }

                            using (MemoryStream ms = new MemoryStream())
                            {
                                if (jpgEncoder != null)
                                {
                                    outBmp.Save(ms, jpgEncoder, encParams);
                                }
                                else
                                {
                                    outBmp.Save(ms, ImageFormat.Jpeg);
                                }

                                byte[] frameBytes = ms.ToArray();
                                byte[] lenBytes = BitConverter.GetBytes(frameBytes.Length);
                                if (BitConverter.IsLittleEndian) Array.Reverse(lenBytes);

                                stream.Write(lenBytes, 0, 4);
                                stream.Write(frameBytes, 0, frameBytes.Length);
                                stream.Flush();
                            }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.WriteLine("BitBlt error: " + ex.Message);
                    break;
                }

                long elapsed = Environment.TickCount - startTick;
                int sleep = (int)(delayMs - elapsed);
                if (sleep > 0) Thread.Sleep(sleep);
            }

            try { client.Close(); } catch { }
        }

        private static void HandleCommand(string cmd)
        {
            if (string.IsNullOrEmpty(cmd)) return;
            string[] parts = cmd.Split(':');
            string action = parts[0];

            if (action == "MOVE" && parts.Length >= 3)
            {
                int x = int.Parse(parts[1]);
                int y = int.Parse(parts[2]);
                SetCursorPos(x, y);
            }
            else if (action == "CLICK" && parts.Length >= 4)
            {
                string btn = parts[1];
                int x = int.Parse(parts[2]);
                int y = int.Parse(parts[3]);
                bool isDouble = parts.Length >= 5 && parts[4] == "1";

                SetCursorPos(x, y);
                Thread.Sleep(5);

                if (btn == "left")
                {
                    mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, (uint)x, (uint)y, 0, UIntPtr.Zero);
                    if (isDouble)
                    {
                        Thread.Sleep(60);
                        mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, (uint)x, (uint)y, 0, UIntPtr.Zero);
                    }
                }
                else if (btn == "right")
                {
                    mouse_event(MOUSEEVENTF_RIGHTDOWN | MOUSEEVENTF_RIGHTUP, (uint)x, (uint)y, 0, UIntPtr.Zero);
                }
                else if (btn == "middle")
                {
                    mouse_event(MOUSEEVENTF_MIDDLEDOWN | MOUSEEVENTF_MIDDLEUP, (uint)x, (uint)y, 0, UIntPtr.Zero);
                }
            }
            else if (action == "DOWN" && parts.Length >= 2)
            {
                string btn = parts[1];
                if (btn == "left") mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
                else if (btn == "right") mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, UIntPtr.Zero);
            }
            else if (action == "UP" && parts.Length >= 2)
            {
                string btn = parts[1];
                if (btn == "left") mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
                else if (btn == "right") mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, UIntPtr.Zero);
            }
            else if (action == "WHEEL" && parts.Length >= 2)
            {
                int delta = int.Parse(parts[1]);
                mouse_event(MOUSEEVENTF_WHEEL, 0, 0, (uint)delta, UIntPtr.Zero);
            }
            else if (action == "TEXT" && parts.Length >= 2)
            {
                string rawText = Encoding.UTF8.GetString(Convert.FromBase64String(parts[1]));
                SendKeys.SendWait(rawText);
            }
            else if (action == "KEY" && parts.Length >= 2)
            {
                string key = parts[1];
                if (key == "Win")
                {
                    keybd_event(VK_LWIN, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
                else if (key == "WinD")
                {
                    keybd_event(VK_LWIN, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_D, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_D, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                    keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
                else if (key == "AltTab")
                {
                    keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_TAB, 0, 0, UIntPtr.Zero);
                    Thread.Sleep(50);
                    keybd_event(VK_TAB, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
                else if (key == "TaskMgr")
                {
                    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_SHIFT, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_ESCAPE, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                    keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                    keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
                else if (key == "Lock")
                {
                    LockWorkStation();
                }
                else if (key == "Enter")
                {
                    keybd_event(VK_RETURN, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
                else if (key == "Esc")
                {
                    keybd_event(VK_ESCAPE, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_ESCAPE, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
                else if (key == "Backspace")
                {
                    keybd_event(VK_BACK, 0, 0, UIntPtr.Zero);
                    keybd_event(VK_BACK, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
                }
            }
        }

        private static ImageCodecInfo GetEncoder(ImageFormat format)
        {
            ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
            foreach (ImageCodecInfo codec in codecs)
            {
                if (codec.FormatID == format.Guid) return codec;
            }
            return null;
        }
    }
}
