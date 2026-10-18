// Remote Hands Windows HUD: the hotkey listener, the prompt/progress window, and the login supervisor.
// It speaks the same JSON-lines protocol as the Mac HUD (see HudLogic.cs for the lines) and is built on the user's PC by
// the compiler that ships with Windows (csc.exe, C# 5): no ?., $"", nameof or expression bodies.
//
//   rh-hud.exe listen                      prints {"event":"hotkey","app":...,"windowTitle":...} when Ctrl+Shift+Space is pressed
//   rh-hud.exe prompt --app=... [--models=JSON --model=KEY]   the window: prints submit/stop/cancel/model lines, reads updates
//   rh-hud.exe supervise --node=... --cli=...   keeps `node cli hud listen` running, with no console window
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace RemoteHands
{
    static class Native
    {
        public const int WM_HOTKEY = 0x0312;
        public const int WM_NCLBUTTONDOWN = 0x00A1;
        public const int HTCAPTION = 2;
        public const int EM_SETCUEBANNER = 0x1501;
        public const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_NOREPEAT = 0x4000;
        public const uint VK_SPACE = 0x20;
        public static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

        [DllImport("user32.dll", SetLastError = true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int processId);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] public static extern bool ReleaseCapture();
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
        [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int x1, int y1, int x2, int y2, int cx, int cy);

        // the mascot's see-through window
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
        [DllImport("user32.dll", SetLastError = true)] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);

        /// <summary>
        /// Brings the window to the front and gives it the keyboard. The hotkey listener first allows any program to do this
        /// (AllowSetForegroundWindow); if the system still refuses, one Alt key tap is the documented way to make it accept.
        /// Nothing here waits on another program's window, so a hung application cannot freeze the prompt.
        /// </summary>
        public static void ForceForeground(IntPtr handle)
        {
            try
            {
                SetForegroundWindow(handle);
                if (GetForegroundWindow() == handle) return;
                keybd_event(0x12, 0, 0, UIntPtr.Zero);   // Alt down
                keybd_event(0x12, 0, 2, UIntPtr.Zero);   // Alt up
                SetForegroundWindow(handle);
            }
            catch (Exception)
            {
                // the window still shows; the person can click it
            }
        }
    }

    static class Theme
    {
        public static readonly Color Background = Color.Black;
        public static readonly Color Border = Color.FromArgb(36, 36, 36);
        public static readonly Color Divider = Color.FromArgb(26, 26, 26);
        public static readonly Color Field = Color.FromArgb(23, 23, 23);
        public static readonly Color Text = Color.FromArgb(245, 245, 245);
        public static readonly Color Secondary = Color.FromArgb(163, 163, 163);
        public static readonly Color Tertiary = Color.FromArgb(112, 112, 112);
        public static readonly Color Accent = Color.FromArgb(97, 163, 255);
        public static readonly Color Success = Color.FromArgb(82, 219, 143);
        public static readonly Color Warning = Color.FromArgb(255, 194, 77);
        public static readonly Color Danger = Color.FromArgb(255, 112, 112);
        public static readonly Color ButtonFill = Color.FromArgb(31, 31, 31);
        /// <summary>The chat pill and the tags under it, and the send button.</summary>
        public static readonly Color Pill = Color.FromArgb(29, 29, 29);
        public static readonly Color PillBorder = Color.FromArgb(61, 61, 61);
        public static readonly Color Send = Color.FromArgb(56, 107, 245);

        public static Color ForTone(Tone tone)
        {
            switch (tone)
            {
                case Tone.Success: return Success;
                case Tone.Warning: return Warning;
                case Tone.Danger: return Danger;
                default: return Accent;
            }
        }
    }

    /// <summary>One place for the lines that go to the daemon (UTF-8, one line each, flushed at once).</summary>
    static class Wire
    {
        static readonly object gate = new object();
        static StreamWriter output;

        public static void Send(string line)
        {
            lock (gate)
            {
                try
                {
                    if (output == null)
                    {
                        output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
                        output.AutoFlush = true;
                        output.NewLine = "\n";
                    }
                    output.WriteLine(line);
                }
                catch (Exception)
                {
                    // the daemon went away; the window closes when its input ends
                }
            }
        }

        public static StreamReader Input()
        {
            return new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        }
    }

    sealed class Dpi
    {
        public static float Factor = 1.0f;
        public static void Init()
        {
            try
            {
                using (var g = Graphics.FromHwnd(IntPtr.Zero)) Factor = g.DpiX / 96.0f;
            }
            catch (Exception)
            {
                Factor = 1.0f;
            }
            if (Factor < 1.0f) Factor = 1.0f;
        }
        public static int S(int value) { return (int)Math.Round(value * Factor); }
    }

    /// <summary>A flat rounded button that never takes focus from the text box.</summary>
    sealed class PillButton : Button
    {
        public PillButton(string text, Color fore, Color fill)
        {
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            FlatAppearance.MouseOverBackColor = Color.FromArgb(48, 48, 48);
            FlatAppearance.MouseDownBackColor = Color.FromArgb(60, 60, 60);
            BackColor = fill;
            ForeColor = fore;
            Text = text;
            Font = new Font("Segoe UI Semibold", 9.5f);
            Cursor = Cursors.Hand;
            TabStop = false;
            UseVisualStyleBackColor = false;
            SizeChanged += delegate { Round(); };
        }

        protected override bool ShowFocusCues { get { return false; } }

        void Round()
        {
            if (Width <= 0 || Height <= 0) return;
            Region = Region.FromHrgn(Native.CreateRoundRectRgn(0, 0, Width + 1, Height + 1, Height, Height));
        }
    }

    sealed class RoundPanel : Panel
    {
        public int Radius = 12;
        public RoundPanel()
        {
            DoubleBuffered = true;
            BackColor = Theme.Background;
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Shapes.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), Radius))
            using (var fill = new SolidBrush(Theme.Field))
            using (var pen = new Pen(Theme.Divider))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(pen, path);
            }
        }
    }

    static class Shapes
    {
        public static GraphicsPath Rounded(Rectangle r, int radius)
        {
            int d = Math.Max(2, radius * 2);
            var path = new GraphicsPath();
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    /// <summary>The words in the prompt window, in one place so they are easy to change.</summary>
    static class Copy
    {
        public const string Placeholder = "Start a new task\u2026";
    }

    /// <summary>A round button with a drawn glyph: the send arrow (dim until there is something to send) or the model sparkle.</summary>
    sealed class RoundButton : Button
    {
        public enum Glyphs { Arrow, Sparkle }

        bool ready;
        readonly Glyphs glyph;
        public bool Outlined;

        public RoundButton(Glyphs glyph)
        {
            this.glyph = glyph;
            FlatStyle = FlatStyle.Flat;
            FlatAppearance.BorderSize = 0;
            FlatAppearance.MouseOverBackColor = Theme.Pill;
            FlatAppearance.MouseDownBackColor = Theme.Pill;
            BackColor = Theme.Pill;
            Cursor = Cursors.Hand;
            TabStop = false;
            UseVisualStyleBackColor = false;
            SizeChanged += delegate { Round(); };
        }

        public bool Ready
        {
            get { return ready; }
            set
            {
                if (ready == value) return;
                ready = value;
                Invalidate();
            }
        }

        protected override bool ShowFocusCues { get { return false; } }

        void Round()
        {
            if (Width <= 0 || Height <= 0) return;
            Region = Region.FromHrgn(Native.CreateRoundRectRgn(0, 0, Width + 1, Height + 1, Width, Height));
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(Theme.Pill);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            float cx = Width / 2f, cy = Height / 2f;
            if (glyph == Glyphs.Sparkle)
            {
                if (Outlined)
                {
                    using (var ring = new Pen(Theme.PillBorder)) e.Graphics.DrawEllipse(ring, 0, 0, Width - 1, Height - 1);
                }
                float r = Width * 0.21f, k = r * 0.12f;
                using (var star = new GraphicsPath())
                using (var brush = new SolidBrush(Theme.Secondary))
                {
                    star.AddBezier(new PointF(cx, cy - r), new PointF(cx + k, cy - k), new PointF(cx + k, cy - k), new PointF(cx + r, cy));
                    star.AddBezier(new PointF(cx + r, cy), new PointF(cx + k, cy + k), new PointF(cx + k, cy + k), new PointF(cx, cy + r));
                    star.AddBezier(new PointF(cx, cy + r), new PointF(cx - k, cy + k), new PointF(cx - k, cy + k), new PointF(cx - r, cy));
                    star.AddBezier(new PointF(cx - r, cy), new PointF(cx - k, cy - k), new PointF(cx - k, cy - k), new PointF(cx, cy - r));
                    star.CloseFigure();
                    e.Graphics.FillPath(brush, star);
                }
                return;
            }
            Color fill = ready ? Theme.Send : Color.FromArgb(40, 58, 108);
            Color arrow = ready ? Color.White : Color.FromArgb(170, 180, 205);
            using (var brush = new SolidBrush(fill)) e.Graphics.FillEllipse(brush, 0, 0, Width - 1, Height - 1);
            using (var pen = new Pen(arrow, Dpi.S(2)))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                float r = Width * 0.25f;
                e.Graphics.DrawLine(pen, cx, cy + r, cx, cy - r);
                e.Graphics.DrawLines(pen, new PointF[] { new PointF(cx - r, cy), new PointF(cx, cy - r), new PointF(cx + r, cy) });
            }
        }
    }

    /// <summary>
    /// The mascot: a window of its own with per-pixel transparency, standing above the prompt (or in the corner of the
    /// progress card). The body and the head are two pictures (the folder of PNGs the daemon writes, see assets/mascot);
    /// the head moves and tilts on the neck toward the cursor, and the face is drawn here, in code, on its dark screen.
    /// MascotBrain decides what it does. Without the pictures it is simply not shown.
    /// </summary>
    sealed class MascotForm : Form
    {
        readonly MascotBrain brain;
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly string dir;
        Bitmap bodySource, headSource, bodyScaled, headScaled, canvas;
        int width, height, centerX, bottomY, bobPixels, ticks;
        string drawnKey = "";
        Point lastCursor;
        public readonly bool Available;
        public readonly double Aspect;
        /// <summary>Raised when "Close" is picked from the right-click menu.</summary>
        public Action CloseRequested;
        readonly ContextMenuStrip menu = new ContextMenuStrip();

        public MascotForm(string dir)
        {
            this.dir = dir;
            brain = new MascotBrain(Environment.TickCount);
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            bodySource = LoadPicture("body");
            headSource = LoadPicture("head");
            if (bodySource != null && headSource != null && bodySource.Size == headSource.Size)
            {
                Available = true;
                Aspect = (double)bodySource.Width / bodySource.Height;
            }
            timer.Interval = 50;
            timer.Tick += delegate { Tick(); };
            var close = new ToolStripMenuItem("Close");
            close.Click += delegate { if (CloseRequested != null) CloseRequested(); };
            menu.Items.Add(close);
            MouseUp += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Right) menu.Show(Cursor.Position);
            };
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                // layered (per-pixel alpha: clear pixels pass clicks through), never takes focus, no taskbar button
                cp.ExStyle |= 0x00080000 | 0x08000000 | 0x00000080;
                return cp;
            }
        }

        Bitmap LoadPicture(string name)
        {
            try
            {
                string file = Path.Combine(dir, name + ".png");
                if (!File.Exists(file)) return null;
                using (var stream = new MemoryStream(File.ReadAllBytes(file)))
                using (var image = Image.FromStream(stream))
                {
                    return new Bitmap(image);
                }
            }
            catch (Exception)
            {
                return null; // a missing or broken picture: no mascot
            }
        }

        static Bitmap Scale(Bitmap source, int w, int h)
        {
            var result = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(result))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(source, new Rectangle(0, 0, w, h));
            }
            return result;
        }

        /// <summary>Stand with its feet at (centerX, bottomY) on the screen, `h` pixels tall.</summary>
        public void Stand(int centerXPixels, int bottomYPixels, int h)
        {
            if (!Available) return;
            centerX = centerXPixels;
            bottomY = bottomYPixels;
            if (h != height)
            {
                height = h;
                width = (int)Math.Round(h * Aspect);
                if (bodyScaled != null) bodyScaled.Dispose();
                if (headScaled != null) headScaled.Dispose();
                if (canvas != null) canvas.Dispose();
                bodyScaled = Scale(bodySource, width, height);
                headScaled = Scale(headSource, width, height);
                canvas = new Bitmap(width, height, PixelFormat.Format32bppArgb);
                drawnKey = "";
            }
            Draw(brain.Latest());
        }

        public void SetMood(Mood mood) { brain.SetMood(mood); }

        public int TypedLength { set { brain.TypedLength = value; } }

        /// <summary>A wink to say hello, then it starts watching.</summary>
        public void Start()
        {
            brain.Play(Expression.Wink, 26, Expression.Neutral, 0);
            timer.Start();
        }

        void Tick()
        {
            ticks++;
            if (canvas == null) return;
            float dpi = Dpi.Factor;
            Point eye = new Point(centerX, bottomY - height + (int)(height * Face.EyeY));
            Point cursor = Cursor.Position;
            bool moved = Math.Abs(cursor.X - lastCursor.X) + Math.Abs(cursor.Y - lastCursor.Y) > 6 * dpi;
            if (moved) lastCursor = cursor;
            double lookX = Math.Max(-1, Math.Min(1, (cursor.X - eye.X) / (240.0 * dpi)));
            double lookY = Math.Max(-1, Math.Min(1, (cursor.Y - eye.Y) / (170.0 * dpi)));
            MascotPose pose = brain.Step(lookX, lookY, moved);
            double sway = (Math.Sin(ticks * Math.PI * 2 / 60.0) * 0.5 + 0.5) * 3;
            int bob = (int)Math.Round((sway + brain.HopOffset()) * dpi);
            string key = pose.Key() + "|" + bob;
            if (key == drawnKey) return;
            drawnKey = key;
            bobPixels = bob;
            Draw(pose);
        }

        // ---- drawing -------------------------------------------------------------------------

        void Draw(MascotPose pose)
        {
            if (canvas == null || !IsHandleCreated) return;
            using (var g = Graphics.FromImage(canvas))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g.DrawImageUnscaled(bodyScaled, 0, 0);
                // the head turns about the neck
                float px = (float)(Face.PivotX * width), py = (float)(Face.PivotY * height);
                g.TranslateTransform(px + (float)(pose.HeadX * width), py + (float)(pose.HeadY * height));
                g.RotateTransform((float)pose.HeadTilt);
                g.TranslateTransform(-px, -py);
                g.DrawImageUnscaled(headScaled, 0, 0);
                DrawFace(g, pose);
            }
            Push();
        }

        static Color Shade(Color c, double alpha)
        {
            return Color.FromArgb((int)Math.Max(0, Math.Min(255, alpha * 255)), c.R, c.G, c.B);
        }

        /// <summary>Quadratic curve as the cubic GDI+ wants.</summary>
        static void Quad(GraphicsPath path, PointF a, PointF c, PointF b)
        {
            var c1 = new PointF(a.X + 2f / 3f * (c.X - a.X), a.Y + 2f / 3f * (c.Y - a.Y));
            var c2 = new PointF(b.X + 2f / 3f * (c.X - b.X), b.Y + 2f / 3f * (c.Y - b.Y));
            path.AddBezier(a, c1, c2, b);
        }

        static GraphicsPath RoundedBox(RectangleF r, float below, float above)
        {
            var path = new GraphicsPath();
            float bd = Math.Max(0.5f, below * 2), td = Math.Max(0.5f, above * 2);
            path.AddArc(r.Left, r.Top, td, td, 180, 90);
            path.AddArc(r.Right - td, r.Top, td, td, 270, 90);
            path.AddArc(r.Right - bd, r.Bottom - bd, bd, bd, 0, 90);
            path.AddArc(r.Left, r.Bottom - bd, bd, bd, 90, 90);
            path.CloseFigure();
            return path;
        }

        /// <summary>The eyes and mouth, in the head's own (turned) coordinates, clipped to its dark screen.</summary>
        void DrawFace(Graphics g, MascotPose pose)
        {
            float W = width, H = height;
            FaceSpec spec = pose.Spec;
            var screen = new RectangleF((float)Face.VisorX0 * W, (float)Face.VisorY0 * H, (float)(Face.VisorX1 - Face.VisorX0) * W, (float)(Face.VisorY1 - Face.VisorY0) * H);
            screen.Inflate(-0.01f * W, -0.008f * H);
            using (var clip = RoundedBox(screen, 0.045f * W, 0.045f * W))
            {
                g.SetClip(clip, CombineMode.Intersect);
            }
            float ew = (float)Face.EyeW * W, eh = (float)Face.EyeH * H;
            float lw = ew * 0.4f;
            float shiftX = (float)(pose.GazeX * Face.GazeShiftX) * W, shiftY = (float)(pose.GazeY * Face.GazeShiftY) * H;
            var left = new PointF((float)Face.EyeLeftX * W + shiftX, (float)Face.EyeY * H + shiftY);
            var right = new PointF((float)Face.EyeRightX * W + shiftX, (float)Face.EyeY * H + shiftY);
            var mouth = new PointF((float)Face.MouthX * W + shiftX * 0.8f, (float)Face.MouthY * H + shiftY * 0.8f);
            Color cyan = spec.Warning ? Color.FromArgb(255, 120, 120) : Color.FromArgb(102, 247, 252);

            DrawEye(g, spec.Left, left, 1, 1, spec, pose, ew, eh, lw, cyan);
            DrawEye(g, spec.Right, right, -1, spec.RightScale, spec, pose, ew, eh, lw, cyan);
            DrawMouth(g, mouth, spec, W, ew, cyan, pose.Fade);
            if (spec.Zzz) DrawZs(g, pose, W, H, cyan);
            g.ResetClip();
        }

        /// <summary>Strokes or fills a shape with a soft glow around it (a few wider, fainter passes underneath).</summary>
        static void Glow(Graphics g, GraphicsPath path, bool fill, Color color, float lineWidth, double fade)
        {
            for (int i = 3; i >= 1; i--)
            {
                using (var pen = new Pen(Shade(color, 0.16 * fade), lineWidth + i * lineWidth * 0.9f))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    g.DrawPath(pen, path);
                }
            }
            if (fill)
            {
                using (var brush = new SolidBrush(Shade(color, fade))) g.FillPath(brush, path);
            }
            else
            {
                using (var pen = new Pen(Shade(color, fade), lineWidth))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    g.DrawPath(pen, path);
                }
            }
        }

        void DrawEye(Graphics g, EyeShape shape, PointF c, float side, double scale, FaceSpec spec, MascotPose pose, float ew, float eh, float lw, Color color)
        {
            float w = (float)(ew * spec.EyeWidth * scale), h = (float)(eh * spec.EyeHeight * scale);
            var state = g.Save();
            g.TranslateTransform(c.X, c.Y);
            using (var path = new GraphicsPath())
            {
                bool fill = false;
                switch (shape)
                {
                    case EyeShape.Open:
                        {
                            float full = Math.Max(lw * 0.7f, h * (float)pose.Openness);
                            float shown = Math.Max(lw * 0.7f, full * (float)(1 - spec.Lid));
                            g.RotateTransform(side * (float)spec.Tilt * -1f);
                            float rb = Math.Min(w, shown) * 0.42f;
                            float rt = spec.Lid > 0 ? Math.Min(w, shown) * 0.12f : rb;
                            using (var box = RoundedBox(new RectangleF(-w / 2, -shown / 2 + (full - shown) / 2, w, shown), rb, rt)) path.AddPath(box, false);
                            fill = true;
                            break;
                        }
                    case EyeShape.ArcUp:
                        Quad(path, new PointF(-w * 0.95f, h * 0.2f), new PointF(0, -h * 0.62f), new PointF(w * 0.95f, h * 0.2f));
                        break;
                    case EyeShape.ArcDown:
                        Quad(path, new PointF(-w * 0.95f, -h * 0.12f), new PointF(0, h * 0.5f), new PointF(w * 0.95f, -h * 0.12f));
                        break;
                    case EyeShape.ChevronRight:
                        path.AddLines(new PointF[] { new PointF(-w * 0.7f, -h * 0.42f), new PointF(w * 0.7f, 0), new PointF(-w * 0.7f, h * 0.42f) });
                        break;
                    case EyeShape.ChevronLeft:
                        path.AddLines(new PointF[] { new PointF(w * 0.7f, -h * 0.42f), new PointF(-w * 0.7f, 0), new PointF(w * 0.7f, h * 0.42f) });
                        break;
                    case EyeShape.Underscore:
                        if (pose.CursorOn) path.AddLine(-w * 0.85f, h * 0.4f, w * 0.85f, h * 0.4f);
                        break;
                    case EyeShape.Cross:
                        path.AddLine(-w * 0.7f, -h * 0.32f, w * 0.7f, h * 0.32f);
                        path.StartFigure();
                        path.AddLine(-w * 0.7f, h * 0.32f, w * 0.7f, -h * 0.32f);
                        break;
                }
                if (path.PointCount > 0) Glow(g, path, fill, color, lw, pose.Fade);
            }
            g.Restore(state);
        }

        void DrawMouth(Graphics g, PointF m, FaceSpec spec, float W, float ew, Color color, double fade)
        {
            float mw = 0.056f * W * (float)spec.MouthSize;
            float k = (float)spec.Curve;
            var state = g.Save();
            g.TranslateTransform(m.X, m.Y);
            using (var path = new GraphicsPath())
            {
                bool fill = false;
                switch (spec.Mouth)
                {
                    case MouthShape.Smile:
                        Quad(path, new PointF(-mw, 0), new PointF(0, k * mw * 1.6f), new PointF(mw, 0));
                        break;
                    case MouthShape.Grin:
                        path.AddLine(-mw, -mw * 0.15f, mw, -mw * 0.15f);
                        path.AddArc(-mw, -mw * 0.15f - mw, mw * 2, mw * 2, 0, 180);
                        path.CloseFigure();
                        fill = true;
                        break;
                    case MouthShape.O:
                        {
                            float r = mw * 0.42f;
                            path.AddEllipse(-r, -r * 1.2f, r * 2, r * 2.4f);
                            break;
                        }
                    case MouthShape.Flat:
                        path.AddLine(-mw * 0.55f, 0, mw * 0.55f, 0);
                        break;
                    case MouthShape.Wave:
                        {
                            var points = new PointF[25];
                            for (int i = 0; i <= 24; i++)
                            {
                                float t = i / 24f;
                                points[i] = new PointF((t - 0.5f) * mw * 1.8f, (float)Math.Sin(t * Math.PI * 3) * mw * 0.18f);
                            }
                            path.AddLines(points);
                            break;
                        }
                    case MouthShape.Smirk:
                        Quad(path, new PointF(-mw * 0.9f, mw * 0.1f), new PointF(mw * 0.1f, k * mw * 1.5f), new PointF(mw, -mw * 0.45f));
                        break;
                }
                Glow(g, path, fill, color, ew * 0.3f, fade);
            }
            g.Restore(state);
        }

        static void DrawZs(Graphics g, MascotPose pose, float W, float H, Color color)
        {
            var baseAt = new PointF(0.6f * W, 0.27f * H);
            for (int i = 0; i < 3; i++)
            {
                double t = (pose.ZPhase + i / 3.0) % 1.0;
                float size = (float)(0.012 + 0.012 * t) * W;
                double alpha = pose.Fade * Math.Sin(t * Math.PI);
                using (var pen = new Pen(Shade(color, alpha), Math.Max(1f, size * 0.28f)))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    pen.LineJoin = LineJoin.Round;
                    float x = baseAt.X + (float)t * 0.04f * W, y = baseAt.Y - (float)t * 0.07f * H;
                    g.DrawLines(pen, new PointF[] { new PointF(x - size, y - size), new PointF(x + size, y - size), new PointF(x - size, y + size), new PointF(x + size, y + size) });
                }
            }
        }

        /// <summary>Hands the picture to the system as the window's whole appearance, with its own transparency.</summary>
        void Push()
        {
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr memoryDc = Native.CreateCompatibleDC(screenDc);
            IntPtr bitmap = IntPtr.Zero;
            IntPtr previous = IntPtr.Zero;
            try
            {
                bitmap = canvas.GetHbitmap(Color.FromArgb(0));
                previous = Native.SelectObject(memoryDc, bitmap);
                var size = new Native.SIZE();
                size.cx = width;
                size.cy = height;
                var source = new Native.POINT();
                var destination = new Native.POINT();
                destination.X = centerX - width / 2;
                destination.Y = bottomY - height - bobPixels;
                var blend = new Native.BLENDFUNCTION();
                blend.BlendOp = 0;          // AC_SRC_OVER
                blend.BlendFlags = 0;
                blend.SourceConstantAlpha = 255;
                blend.AlphaFormat = 1;      // AC_SRC_ALPHA: use the picture's own transparency
                Native.UpdateLayeredWindow(Handle, screenDc, ref destination, ref size, memoryDc, ref source, 0, ref blend, 2);
            }
            catch (Exception)
            {
                // a drawing hiccup: the next tick tries again
            }
            finally
            {
                if (bitmap != IntPtr.Zero)
                {
                    Native.SelectObject(memoryDc, previous);
                    Native.DeleteObject(bitmap);
                }
                Native.DeleteDC(memoryDc);
                Native.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) timer.Dispose();
            base.Dispose(disposing);
        }
    }

    /// <summary>
    /// The progress view: a small toolbar and a stack of cards (your request with its live status, the steps, the answer),
    /// drawn by hand into one see-through window so the cards have soft edges and fade at the top and bottom. Nothing here
    /// takes the keyboard: the prompt pill under it keeps the focus. CardStack (HudLogic.cs) holds the rules.
    /// </summary>
    sealed class CardsForm : Form
    {
        sealed class Hit
        {
            public Rectangle Rect;
            public string Id;
        }

        const int TicksPerSecond = 20;
        readonly CardStack stack = new CardStack();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        readonly List<Hit> hits = new List<Hit>();
        readonly Dictionary<Card, int> born = new Dictionary<Card, int>();
        readonly Font requestFont, stepFont, noteFont, statusFont, answerFont;
        readonly StringFormat format;
        readonly Bitmap scratch = new Bitmap(1, 1);
        readonly Graphics measure;
        readonly int cardWidth, margin, barWidth, barHeight, pad, vertical, radius, iconSize;
        Bitmap canvas, content;
        int tick, scroll, contentHeight, maxViewport, viewportHeight, formWidth, formHeight;
        int copiedUntil;
        bool collapsed, hovering, dirty, working, copyReady;
        string hot = "";
        Point origin;
        string statusWord = "Starting";
        Color statusColor = Theme.Secondary;

        public event Action StopRequested, CloseRequested, FollowUpRequested, CopyRequested, LayoutChanged;

        public int FormWidth { get { return formWidth; } }
        public int FormHeight { get { return formHeight; } }
        public int EdgeMargin { get { return margin; } }
        public int BarHeight { get { return barHeight; } }
        public int ContentHeight { get { return contentHeight; } }

        public CardsForm(int cardWidthPixels)
        {
            cardWidth = cardWidthPixels;
            margin = Dpi.S(12);
            barWidth = Dpi.S(132);
            barHeight = Dpi.S(CardStack.ToolbarHeight);
            pad = Dpi.S(14);
            vertical = Dpi.S(12);
            radius = Dpi.S(18);
            iconSize = Dpi.S(18);
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            requestFont = Px("Segoe UI Semibold", 14);
            stepFont = Px("Segoe UI Semibold", 13.5f);
            noteFont = Px("Segoe UI", 13);
            statusFont = Px("Segoe UI", 13);
            answerFont = Px("Segoe UI", 13.5f);
            format = new StringFormat(StringFormat.GenericTypographic);
            format.Trimming = StringTrimming.None;
            format.FormatFlags = StringFormatFlags.MeasureTrailingSpaces | StringFormatFlags.NoClip;
            measure = Graphics.FromImage(scratch);
            measure.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
            formWidth = cardWidth + 2 * margin;
            formHeight = 2 * margin + barHeight;
            timer.Interval = 1000 / TicksPerSecond;
            timer.Tick += delegate { OnTick(); };
            MouseMove += OnMove;
            MouseUp += OnUp;
            MouseLeave += delegate { hovering = false; hot = ""; Cursor = Cursors.Default; dirty = true; };
            MouseWheel += OnWheel;
        }

        static Font Px(string family, float px)
        {
            return new Font(family, px * Dpi.Factor, FontStyle.Regular, GraphicsUnit.Pixel);
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                // layered (per-pixel alpha: clear pixels pass clicks through), never takes focus, no taskbar button
                cp.ExStyle |= 0x00080000 | 0x08000000 | 0x00000080;
                return cp;
            }
        }

        // ---- what the window is told ----------------------------------------------------------

        public void Start()
        {
            timer.Start();
            Relayout();
        }

        public void Reset()
        {
            stack.Clear();
            born.Clear();
            scroll = 0;
            collapsed = false;
            Relayout();
        }

        public void AddEntry(FeedEntry entry, bool isWorking)
        {
            if (entry.Kind == EntryKind.Goal && stack.Request != null)
            {
                // the older request keeps its last status as plain words
                stack.Request.Body = Snapshot(stack.Request);
            }
            bool atEnd = scroll >= contentHeight - viewportHeight - Dpi.S(24);
            Card card = stack.Add(entry, tick, isWorking);
            born[card] = tick;
            Measure(card);
            Relayout();
            if (card.Kind == CardKind.Answer) scroll = CardStack.ClampScroll(card.Y - Dpi.S(6), contentHeight, viewportHeight);
            else if (atEnd || stack.Cards.Count == 1) scroll = CardStack.ClampScroll(contentHeight, contentHeight, viewportHeight);
            dirty = true;
        }

        public void SetStatus(string word, Color color, bool isWorking)
        {
            statusWord = word;
            statusColor = word == "Starting" ? Theme.Secondary : color;
            working = isWorking;
            stack.SetWorking(isWorking, tick, TicksPerSecond);
            dirty = true;
        }

        public void SetCopyReady(bool ready)
        {
            copyReady = ready;
            dirty = true;
        }

        public void FlashCopied()
        {
            copiedUntil = tick + TicksPerSecond * 8 / 5;
            dirty = true;
        }

        /// <summary>The most the cards may take, set by the window from the room there is on screen.</summary>
        public void SetMaxViewport(int pixels)
        {
            if (pixels == maxViewport) return;
            maxViewport = pixels;
            Relayout();
        }

        public void PlaceAt(int left, int top)
        {
            if (origin.X == left && origin.Y == top && canvas != null) return;
            origin = new Point(left, top);
            dirty = true;
            Render();
        }

        // ---- layout --------------------------------------------------------------------------

        void Measure(Card card)
        {
            bool icon = card.Kind != CardKind.Request;
            int textX = pad + (icon ? Dpi.S(28) : 0);
            int reserve = card.Kind == CardKind.Request ? Dpi.S(82) : 0;
            int textW = cardWidth - textX - pad - reserve;
            int titleH = TextHeight(card.Title, TitleFont(card), textW);
            int h = vertical + titleH;
            if (card.Kind == CardKind.Request) h += Dpi.S(3) + (int)Math.Ceiling(statusFont.GetHeight(measure));
            else if (card.Kind == CardKind.Answer) h += Dpi.S(3) + TextHeight(card.Body, answerFont, textW);
            card.TitleHeight = titleH;
            card.Height = Math.Max(Dpi.S(46), h + vertical);
        }

        int TextHeight(string text, Font font, int width)
        {
            SizeF size = measure.MeasureString(text, font, new SizeF(width, 100000), format);
            return (int)Math.Ceiling(size.Height);
        }

        Font TitleFont(Card card)
        {
            switch (card.Kind)
            {
                case CardKind.Request: return requestFont;
                case CardKind.Answer: return requestFont;
                case CardKind.Note: return noteFont;
                default: return stepFont;
            }
        }

        void Relayout()
        {
            contentHeight = stack.Layout();
            viewportHeight = collapsed || stack.Cards.Count == 0 ? 0 : Math.Min(contentHeight, maxViewport > 0 ? maxViewport : Dpi.S(250));
            scroll = CardStack.ClampScroll(scroll, contentHeight, viewportHeight);
            int w = cardWidth + 2 * margin;
            int h = 2 * margin + barHeight + (viewportHeight > 0 ? Dpi.S(8) + viewportHeight : 0);
            bool resized = w != formWidth || h != formHeight || canvas == null;
            formWidth = w;
            formHeight = h;
            dirty = true;
            if (resized)
            {
                if (canvas != null) canvas.Dispose();
                if (content != null) content.Dispose();
                canvas = new Bitmap(formWidth, formHeight, PixelFormat.Format32bppArgb);
                content = viewportHeight > 0 ? new Bitmap(formWidth, viewportHeight + 2 * margin, PixelFormat.Format32bppArgb) : null;
            }
            Render();
            if (LayoutChanged != null) LayoutChanged();
        }

        // ---- ticking -------------------------------------------------------------------------

        void OnTick()
        {
            tick++;
            if (copiedUntil != 0 && tick > copiedUntil)
            {
                copiedUntil = 0;
                dirty = true;
            }
            var done = new List<Card>();
            foreach (KeyValuePair<Card, int> pair in born)
            {
                if (tick - pair.Value > 7) done.Add(pair.Key);
            }
            foreach (Card card in done) born.Remove(card);
            bool animating = working || born.Count > 0;
            if (!animating)
            {
                foreach (Card card in stack.Cards)
                {
                    if (card.InProgress) animating = true;
                }
            }
            if (animating || dirty) Render();
        }

        // ---- drawing -------------------------------------------------------------------------

        static Color Alpha(Color c, double k)
        {
            return Color.FromArgb((int)Math.Max(0, Math.Min(255, c.A * k)), c.R, c.G, c.B);
        }

        static Color Mix(Color a, Color b, double t)
        {
            return Color.FromArgb((int)(a.A + (b.A - a.A) * t), (int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t));
        }

        string Snapshot(Card card)
        {
            int seconds = card.Working ? (tick - card.StartedTick) / TicksPerSecond : Math.Max(0, card.FinishedSeconds);
            return CardStack.StatusLine(statusWord, false, 0, seconds);
        }

        string StatusText(Card card, bool live)
        {
            if (!live) return card.Body;
            int seconds = card.Working ? (tick - card.StartedTick) / TicksPerSecond : Math.Max(0, card.FinishedSeconds);
            return CardStack.StatusLine(statusWord, card.Working, (tick / 8) % 4, seconds);
        }

        void Render()
        {
            if (canvas == null || !IsHandleCreated)
            {
                dirty = true;
                return;
            }
            dirty = false;
            hits.Clear();
            using (var g = Graphics.FromImage(canvas))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
                DrawBar(g);
                if (viewportHeight > 0 && content != null) DrawCards(g);
            }
            Push();
        }

        void DrawBar(Graphics g)
        {
            var bar = new Rectangle((formWidth - barWidth) / 2, margin, barWidth, barHeight);
            using (var path = Shapes.Rounded(new Rectangle(bar.X, bar.Y, bar.Width - 1, bar.Height - 1), barHeight / 2))
            using (var fill = new SolidBrush(Theme.Pill))
            using (var pen = new Pen(Theme.PillBorder))
            {
                g.FillPath(fill, path);
                g.DrawPath(pen, path);
            }
            int third = barWidth / 3;
            string[] ids = new string[] { "new", "copy", "fold" };
            for (int i = 0; i < 3; i++)
            {
                var cell = new Rectangle(bar.X + i * third, bar.Y, third, barHeight);
                hits.Add(new Hit { Rect = cell, Id = ids[i] });
                if (hot == ids[i])
                {
                    var inner = new Rectangle(cell.X + Dpi.S(4), cell.Y + Dpi.S(4), cell.Width - Dpi.S(8), cell.Height - Dpi.S(8));
                    using (var hover = Shapes.Rounded(inner, inner.Height / 2))
                    using (var brush = new SolidBrush(Color.FromArgb(28, 255, 255, 255)))
                    {
                        g.FillPath(brush, hover);
                    }
                }
                var center = new PointF(cell.X + cell.Width / 2f, cell.Y + cell.Height / 2f);
                bool flashed = ids[i] == "copy" && copiedUntil != 0;
                string glyph = ids[i] == "new" ? "pencil" : ids[i] == "copy" ? (flashed ? "check" : "copy") : (collapsed ? "chevronUp" : "chevronDown");
                Color color = flashed ? Theme.Success : (ids[i] == "copy" && !copyReady ? Theme.Tertiary : Theme.Secondary);
                DrawGlyph(g, glyph, center, color, 1f);
            }
            using (var line = new Pen(Color.FromArgb(34, 255, 255, 255)))
            {
                for (int i = 1; i < 3; i++)
                {
                    g.DrawLine(line, bar.X + i * third, bar.Y + Dpi.S(10), bar.X + i * third, bar.Bottom - Dpi.S(10));
                }
            }
        }

        void DrawCards(Graphics screen)
        {
            int top = margin + barHeight + Dpi.S(8);          // the viewport's top edge on the canvas
            using (var g = Graphics.FromImage(content))
            {
                g.Clear(Color.Transparent);
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
                // scrolled cards are cut at the viewport's edge (and fade there); at the very top the corner badge may overhang
                int clipTop = scroll > 0 ? margin : 0;
                bool atEnd = scroll >= contentHeight - viewportHeight;
                int clipBottom = atEnd ? content.Height : margin + viewportHeight;
                g.SetClip(new Rectangle(0, clipTop, content.Width, clipBottom - clipTop));
                int count = stack.Cards.Count;
                for (int i = 0; i < count; i++)
                {
                    Card card = stack.Cards[i];
                    int y = margin + card.Y - scroll;
                    if (y > content.Height || y + card.Height < 0) continue;
                    double appear = 1;
                    int shift = 0;
                    int bornAt;
                    if (born.TryGetValue(card, out bornAt))
                    {
                        appear = Math.Min(1, (tick - bornAt) / 6.0);
                        shift = (int)((1 - appear) * Dpi.S(16));
                    }
                    bool dim = CardStack.IsDimmed(i, count, hovering);
                    DrawCard(g, card, new Rectangle(margin, y + shift, cardWidth, card.Height), appear, dim ? 0.5 : 1.0, top - margin);
                }
            }
            FadeEdges(top);
            screen.DrawImageUnscaled(content, 0, top - margin);
        }

        void FadeEdges(int top)
        {
            int band = Math.Min(Dpi.S(40), viewportHeight * 2 / 5);
            double topFade = CardStack.TopFade(scroll);
            double bottomFade = CardStack.BottomFade(scroll, contentHeight, viewportHeight);
            if (band <= 0 || (topFade >= 1 && bottomFade >= 1)) return;
            BitmapData data = content.LockBits(new Rectangle(0, 0, content.Width, content.Height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            try
            {
                var row = new byte[data.Stride];
                for (int i = 0; i < content.Height; i++)
                {
                    int inside = i - margin;                       // 0 at the viewport's top edge
                    double k = 1;
                    if (inside < band) k = Math.Min(k, topFade + (1 - topFade) * Math.Max(0, inside) / (double)band);
                    int fromBottom = viewportHeight - inside;
                    if (fromBottom < band) k = Math.Min(k, bottomFade + (1 - bottomFade) * Math.Max(0, fromBottom) / (double)band);
                    if (k >= 1) continue;
                    IntPtr line = new IntPtr(data.Scan0.ToInt64() + (long)i * data.Stride);
                    Marshal.Copy(line, row, 0, data.Stride);
                    for (int x = 3; x < data.Stride; x += 4) row[x] = (byte)(row[x] * k);
                    Marshal.Copy(row, 0, line, data.Stride);
                }
            }
            finally
            {
                content.UnlockBits(data);
            }
        }

        void DrawCard(Graphics g, Card card, Rectangle r, double appear, double textAlpha, int contentOriginY)
        {
            double ink = appear * textAlpha;
            Color border = Theme.PillBorder;
            bool live = card.Kind == CardKind.Request && card.Latest;
            if (live && card.Working) border = Mix(Theme.PillBorder, Color.FromArgb(255, Theme.Accent), (Math.Sin(tick * Math.PI * 2 / 44.0) + 1) / 2 * 0.6);
            using (var path = Shapes.Rounded(new Rectangle(r.X, r.Y, r.Width - 1, r.Height - 1), radius))
            using (var fill = new SolidBrush(Alpha(Theme.Pill, appear)))
            using (var pen = new Pen(Alpha(border, appear)))
            {
                g.FillPath(fill, path);
                g.DrawPath(pen, path);
            }
            bool icon = card.Kind != CardKind.Request;
            int textX = r.X + pad + (icon ? Dpi.S(28) : 0);
            int reserve = card.Kind == CardKind.Request ? Dpi.S(82) : 0;
            int textW = cardWidth - (textX - r.X) - pad - reserve;
            Color titleColor = Theme.Text;
            if (card.Kind == CardKind.Note) titleColor = Theme.Tertiary;
            else if (card.Kind == CardKind.Attention) titleColor = Theme.Warning;
            else if (card.Kind == CardKind.Error) titleColor = Theme.Danger;
            Font titleFont = TitleFont(card);
            DrawText(g, card.Title, titleFont, Alpha(titleColor, ink), textX, r.Y + vertical, textW, card.TitleHeight);
            int bodyY = r.Y + vertical + card.TitleHeight + Dpi.S(3);
            if (card.Kind == CardKind.Request)
            {
                Color statusInk = card.Latest ? statusColor : Theme.Secondary;
                DrawText(g, StatusText(card, card.Latest), statusFont, Alpha(statusInk, ink), textX, bodyY, textW, (int)Math.Ceiling(statusFont.GetHeight(g)));
            }
            else if (card.Kind == CardKind.Answer)
            {
                DrawText(g, card.Body, answerFont, Alpha(Color.FromArgb(204, 204, 204), ink), textX, bodyY, textW, card.Height - (bodyY - r.Y) - vertical);
            }
            if (icon)
            {
                float iy = r.Y + vertical + (Math.Min(card.TitleHeight, iconSize) - iconSize) / 2f + 0.5f;
                DrawIcon(g, card, new RectangleF(r.X + pad, iy, iconSize, iconSize), ink);
            }
            DrawCardButtons(g, card, r, appear, contentOriginY);
        }

        void DrawText(Graphics g, string text, Font font, Color color, int x, int y, int width, int height)
        {
            if (text == null || text.Length == 0) return;
            using (var brush = new SolidBrush(color))
            {
                g.DrawString(text, font, brush, new RectangleF(x, y, width, height + Dpi.S(4)), format);
            }
        }

        void DrawIcon(Graphics g, Card card, RectangleF box, double ink)
        {
            Color color = Theme.Success;
            string kind = "check";
            if (card.Kind == CardKind.Error) { color = Theme.Danger; kind = "cross"; }
            else if (card.Kind == CardKind.Attention) { color = Theme.Warning; kind = "bang"; }
            else if (card.Kind == CardKind.Note) { color = Color.FromArgb(255, 112, 112, 112); kind = "dot"; }
            else if (card.Kind == CardKind.Step && card.InProgress) { color = Theme.Accent; kind = "spin"; }
            var center = new PointF(box.X + box.Width / 2f, box.Y + box.Height / 2f);
            float u = Dpi.Factor;
            if (kind == "spin")
            {
                using (var pen = new Pen(Alpha(color, ink), 2f * u))
                {
                    pen.StartCap = LineCap.Round;
                    pen.EndCap = LineCap.Round;
                    var ring = new RectangleF(center.X - 6.5f * u, center.Y - 6.5f * u, 13f * u, 13f * u);
                    g.DrawArc(pen, ring, (tick * 24) % 360, 260);
                }
                return;
            }
            if (kind == "dot")
            {
                using (var brush = new SolidBrush(Alpha(color, ink))) g.FillEllipse(brush, center.X - 3f * u, center.Y - 3f * u, 6f * u, 6f * u);
                return;
            }
            using (var back = new SolidBrush(Alpha(color, ink * 0.18))) g.FillEllipse(back, box);
            DrawGlyph(g, kind, center, Alpha(color, ink), 0.9f);
        }

        void DrawCardButtons(Graphics g, Card card, Rectangle r, double appear, int contentOriginY)
        {
            if (appear < 1) return;
            Action<Rectangle, string, string, Color, Color> button = delegate(Rectangle rect, string id, string glyph, Color fill, Color ink)
            {
                var onForm = new Rectangle(rect.X, rect.Y + contentOriginY, rect.Width, rect.Height);
                bool visible = onForm.Bottom > contentOriginY + margin - 1 && onForm.Y < contentOriginY + margin + viewportHeight;
                if (visible) hits.Add(new Hit { Rect = onForm, Id = id });
                if (fill.A > 0)
                {
                    using (var brush = new SolidBrush(hot == id ? Mix(fill, Color.White, 0.18) : fill)) g.FillEllipse(brush, rect);
                }
                else if (hot == id)
                {
                    using (var brush = new SolidBrush(Color.FromArgb(28, 255, 255, 255))) g.FillEllipse(brush, rect);
                }
                DrawGlyph(g, glyph, new PointF(rect.X + rect.Width / 2f, rect.Y + rect.Height / 2f), ink, 1f);
            };
            if (card.Kind == CardKind.Request && card.Latest)
            {
                int size = Dpi.S(30);
                int rightEdge = r.Right - Dpi.S(14);
                int mid = r.Y + (r.Height - size) / 2;
                var soft = Color.FromArgb(26, 255, 255, 255);
                bool stopShown = card.Working;
                if (stopShown) button(new Rectangle(rightEdge - size, mid, size, size), "stop", "stopSquare", soft, Theme.Text);
                int retX = stopShown ? rightEdge - size - Dpi.S(8) - size : rightEdge - size;
                button(new Rectangle(retX, mid, size, size), "ret", "returnKey", soft, Theme.Secondary);
                int badge = Dpi.S(20);
                button(new Rectangle(r.X - Dpi.S(7), r.Y - Dpi.S(7), badge, badge), "close", "cross", Color.FromArgb(237, 237, 237), Color.Black);
            }
            else if (card.Kind == CardKind.Answer)
            {
                int size = Dpi.S(28);
                bool flashed = copiedUntil != 0;
                button(new Rectangle(r.Right - pad - size + Dpi.S(4), r.Y + Dpi.S(7), size, size), "acopy", flashed ? "check" : "copy", Color.Transparent, flashed ? Theme.Success : Theme.Secondary);
            }
        }

        /// <summary>The little pictures on buttons, drawn with lines around a centre point.</summary>
        static void DrawGlyph(Graphics g, string name, PointF c, Color color, float scale)
        {
            float u = Dpi.Factor * scale;
            using (var pen = new Pen(color, 1.7f * Dpi.Factor))
            using (var brush = new SolidBrush(color))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                switch (name)
                {
                    case "pencil":
                        g.DrawLine(pen, c.X - 4.5f * u, c.Y + 4.5f * u, c.X + 4f * u, c.Y - 4f * u);
                        g.DrawLine(pen, c.X + 2f * u, c.Y - 6f * u, c.X + 6f * u, c.Y - 2f * u);
                        g.DrawLine(pen, c.X - 6.5f * u, c.Y + 7f * u, c.X - 1f * u, c.Y + 7f * u);
                        break;
                    case "copy":
                        g.DrawRectangle(pen, c.X - 2f * u, c.Y - 6f * u, 8f * u, 8f * u);
                        g.DrawLines(pen, new PointF[] { new PointF(c.X - 4f * u, c.Y + 2f * u), new PointF(c.X - 6f * u, c.Y + 2f * u), new PointF(c.X - 6f * u, c.Y - 4f * u), new PointF(c.X - 4f * u, c.Y - 4f * u) });
                        g.DrawLine(pen, c.X - 6f * u, c.Y + 2f * u, c.X - 6f * u, c.Y + 6f * u);
                        g.DrawLine(pen, c.X - 6f * u, c.Y + 6f * u, c.X, c.Y + 6f * u);
                        break;
                    case "check":
                        g.DrawLines(pen, new PointF[] { new PointF(c.X - 4f * u, c.Y), new PointF(c.X - 1f * u, c.Y + 3f * u), new PointF(c.X + 4.5f * u, c.Y - 3.5f * u) });
                        break;
                    case "cross":
                        g.DrawLine(pen, c.X - 3.2f * u, c.Y - 3.2f * u, c.X + 3.2f * u, c.Y + 3.2f * u);
                        g.DrawLine(pen, c.X - 3.2f * u, c.Y + 3.2f * u, c.X + 3.2f * u, c.Y - 3.2f * u);
                        break;
                    case "bang":
                        g.DrawLine(pen, c.X, c.Y - 4f * u, c.X, c.Y + 1f * u);
                        g.FillEllipse(brush, c.X - 1f * u, c.Y + 3f * u, 2f * u, 2f * u);
                        break;
                    case "chevronDown":
                        g.DrawLines(pen, new PointF[] { new PointF(c.X - 5f * u, c.Y - 2.5f * u), new PointF(c.X, c.Y + 2.5f * u), new PointF(c.X + 5f * u, c.Y - 2.5f * u) });
                        break;
                    case "chevronUp":
                        g.DrawLines(pen, new PointF[] { new PointF(c.X - 5f * u, c.Y + 2.5f * u), new PointF(c.X, c.Y - 2.5f * u), new PointF(c.X + 5f * u, c.Y + 2.5f * u) });
                        break;
                    case "returnKey":
                        g.DrawLines(pen, new PointF[] { new PointF(c.X + 5.5f * u, c.Y - 5f * u), new PointF(c.X + 5.5f * u, c.Y + 1.5f * u), new PointF(c.X - 5f * u, c.Y + 1.5f * u) });
                        g.DrawLines(pen, new PointF[] { new PointF(c.X - 1.5f * u, c.Y - 2f * u), new PointF(c.X - 5f * u, c.Y + 1.5f * u), new PointF(c.X - 1.5f * u, c.Y + 5f * u) });
                        break;
                    case "stopSquare":
                        g.FillRectangle(brush, c.X - 4f * u, c.Y - 4f * u, 8f * u, 8f * u);
                        break;
                }
            }
        }

        // ---- the mouse -----------------------------------------------------------------------

        void OnMove(object sender, MouseEventArgs e)
        {
            string id = "";
            foreach (Hit hit in hits)
            {
                if (hit.Rect.Contains(e.Location)) id = hit.Id;
            }
            int viewTop = margin + barHeight + Dpi.S(8);
            bool inside = viewportHeight > 0 && e.Y >= viewTop - margin && e.Y <= viewTop + viewportHeight;
            if (id != hot || inside != hovering)
            {
                hot = id;
                hovering = inside;
                Cursor = id.Length > 0 ? Cursors.Hand : Cursors.Default;
                Render();
            }
        }

        void OnUp(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            string id = "";
            foreach (Hit hit in hits)
            {
                if (hit.Rect.Contains(e.Location)) id = hit.Id;
            }
            switch (id)
            {
                case "new":
                case "ret":
                    if (FollowUpRequested != null) FollowUpRequested();
                    break;
                case "copy":
                case "acopy":
                    if (CopyRequested != null) CopyRequested();
                    break;
                case "fold":
                    collapsed = !collapsed;
                    Relayout();
                    break;
                case "stop":
                    if (StopRequested != null) StopRequested();
                    break;
                case "close":
                    if (CloseRequested != null) CloseRequested();
                    break;
            }
        }

        void OnWheel(object sender, MouseEventArgs e)
        {
            if (viewportHeight <= 0) return;
            int next = CardStack.ClampScroll(scroll - e.Delta * Dpi.S(60) / 120, contentHeight, viewportHeight);
            if (next == scroll) return;
            scroll = next;
            Render();
        }

        // ---- handing the picture to the system -----------------------------------------------

        void Push()
        {
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr memoryDc = Native.CreateCompatibleDC(screenDc);
            IntPtr bitmap = IntPtr.Zero;
            IntPtr previous = IntPtr.Zero;
            try
            {
                bitmap = canvas.GetHbitmap(Color.FromArgb(0));
                previous = Native.SelectObject(memoryDc, bitmap);
                var size = new Native.SIZE();
                size.cx = canvas.Width;
                size.cy = canvas.Height;
                var source = new Native.POINT();
                var destination = new Native.POINT();
                destination.X = origin.X;
                destination.Y = origin.Y;
                var blend = new Native.BLENDFUNCTION();
                blend.BlendOp = 0;
                blend.BlendFlags = 0;
                blend.SourceConstantAlpha = 255;
                blend.AlphaFormat = 1;
                Native.UpdateLayeredWindow(Handle, screenDc, ref destination, ref size, memoryDc, ref source, 0, ref blend, 2);
            }
            catch (Exception)
            {
                // a drawing hiccup: the next tick tries again
            }
            finally
            {
                if (bitmap != IntPtr.Zero)
                {
                    Native.SelectObject(memoryDc, previous);
                    Native.DeleteObject(bitmap);
                }
                Native.DeleteDC(memoryDc);
                Native.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            dirty = true;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                timer.Dispose();
                measure.Dispose();
                scratch.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    /// <summary>The window: a prompt pill that stays under the progress cards once a request is sent.</summary>
    sealed class PromptForm : Form
    {
        readonly HudArgs args;
        readonly HudState state = new HudState();
        string modelKey;

        readonly TextBox input = new TextBox();
        readonly RoundButton sendButton = new RoundButton(RoundButton.Glyphs.Arrow);
        readonly RoundButton modelGlyph = new RoundButton(RoundButton.Glyphs.Sparkle);
        MascotForm mascot;
        Rectangle pillRect;
        CardsForm cards;
        readonly ContextMenuStrip modelMenu = new ContextMenuStrip();
        readonly ToolTip tips = new ToolTip();
        int columnTop;
        bool arranging;
        bool closing;

        public PromptForm(HudArgs args)
        {
            this.args = args;
            modelKey = args.ModelKey;
            SuspendLayout();
            Text = "Remote Hands";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Theme.Background;
            ForeColor = Theme.Text;
            KeyPreview = true;
            DoubleBuffered = true;
            AutoScaleMode = AutoScaleMode.None;

            input.BorderStyle = BorderStyle.None;
            input.Multiline = true;      // the pill grows with the text; Enter sends, Shift+Enter starts a new line
            input.WordWrap = true;
            input.ScrollBars = ScrollBars.None;
            input.BackColor = Theme.Background;
            input.ForeColor = Theme.Text;
            input.Font = new Font("Segoe UI", 15f);

            modelGlyph.Outlined = true;
            modelGlyph.Visible = args.Models.Count > 0;
            modelGlyph.Click += OnModelClicked;
            UpdateModelButton();

            Controls.Add(sendButton);
            Controls.Add(modelGlyph);
            Controls.Add(input);

            // Every part of the window except the controls drags it.
            MouseDown += DragWindow;

            input.KeyDown += OnInputKeyDown;
            input.TextChanged += OnInputChanged;
            sendButton.Click += delegate { Submit(); input.Focus(); };
            LocationChanged += delegate { OnMoved(); };
            Layout_Collapsed();
            ResumeLayout(false);
        }

        // ---- layout ------------------------------------------------------------------------

        Rectangle WorkArea()
        {
            return Screen.FromPoint(Cursor.Position).WorkingArea;
        }

        /// <summary>The small prompt: a chat pill that grows with the text, and a round model button beside it (the mascot stands on top).</summary>
        void Layout_Collapsed()
        {
            bool hasModels = args.Models.Count > 0;
            int w = Dpi.S(420) + (hasModels ? Dpi.S(8) + Dpi.S(52) : 0), h = Dpi.S(52);
            Rectangle wa = WorkArea();
            Bounds = new Rectangle(wa.Left + (wa.Width - w) / 2, wa.Top + Math.Max(Dpi.S(190), (int)(wa.Height * 0.34)), w, h);
            BackColor = Theme.Pill;
            input.BackColor = Theme.Pill;
            input.Font = new Font("Segoe UI", 11.25f);
            sendButton.Visible = true;
            modelGlyph.Visible = hasModels;
            LayoutPill();
        }

        /// <summary>
        /// The pill is the text plus 15 above and below it; the send arrow sits on its bottom line and the window grows
        /// upward, so the mascot rides on top. Only the pill and the round button are part of the window: the gap
        /// between them is see-through and click-through.
        /// </summary>
        void LayoutPill()
        {
            int pillW = Dpi.S(420), minH = Dpi.S(52), gap = Dpi.S(8), left = Dpi.S(22), right = Dpi.S(52);
            bool hasModels = args.Models.Count > 0;
            int lineH = TextRenderer.MeasureText("Ag", input.Font).Height;
            int measured = lineH;
            if (input.Text.Length > 0)
            {
                measured = TextRenderer.MeasureText(input.Text + "x", input.Font, new Size(pillW - left - right - Dpi.S(8), 10000), TextFormatFlags.WordBreak | TextFormatFlags.NoPadding).Height;
            }
            int textH = Math.Min(lineH * 9 + Dpi.S(4), Math.Max(Dpi.S(22), measured + Dpi.S(4)));
            int pillH = Math.Max(minH, textH + Dpi.S(30));
            int w = pillW + (hasModels ? gap + minH : 0);
            int bottom = Top + Height;
            // small prompt: grows upward under the mascot; progress view: the cards sit above, so it grows downward
            Bounds = new Rectangle(Left, state.IsExpanded ? Top : bottom - pillH, w, pillH);
            pillRect = new Rectangle(0, 0, pillW, pillH);
            input.Bounds = new Rectangle(left, Dpi.S(15), pillW - left - right, textH);
            sendButton.Bounds = new Rectangle(pillW - Dpi.S(10) - Dpi.S(32), pillH - Dpi.S(10) - Dpi.S(32), Dpi.S(32), Dpi.S(32));
            modelGlyph.Bounds = new Rectangle(pillW + gap, pillH - minH, minH, minH);
            using (var path = new GraphicsPath())
            {
                using (var pill = Shapes.Rounded(pillRect, Dpi.S(26))) path.AddPath(pill, false);
                if (hasModels)
                {
                    using (var round = Shapes.Rounded(modelGlyph.Bounds, minH / 2)) path.AddPath(round, false);
                }
                Region = new Region(path);
            }
            if (state.IsExpanded) ArrangeColumn(); else PlaceMascot();
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var pen = new Pen(Theme.PillBorder))
            using (var pill = Shapes.Rounded(new Rectangle(0, 0, pillRect.Width - 1, pillRect.Height - 1), Dpi.S(26)))
            {
                e.Graphics.DrawPath(pen, pill);
            }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x80; // WS_EX_TOOLWINDOW: no taskbar button, no Alt+Tab entry
                return cp;
            }
        }

        void DragWindow(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            Native.ReleaseCapture();
            Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, new IntPtr(Native.HTCAPTION), IntPtr.Zero);
        }

        // ---- start and focus ----------------------------------------------------------------

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            Native.ForceForeground(Handle);
            Activate();
            SetPlaceholder(Copy.Placeholder);
            input.Focus();
            StartMascot();
            // A one-shot prompt has no daemon to listen to: it prints the first request and ends.
            if (!args.Once)
            {
                var reader = new Thread(ReadDaemon);
                reader.IsBackground = true;
                reader.Start();
            }
        }

        void SetPlaceholder(string text)
        {
            try
            {
                Native.SendMessage(input.Handle, Native.EM_SETCUEBANNER, new IntPtr(1), text);
            }
            catch (Exception)
            {
                // no placeholder is not a problem
            }
        }

        // ---- what the person does ------------------------------------------------------------

        // ---- the mascot ----------------------------------------------------------------------

        static string MascotDir()
        {
            string over = Environment.GetEnvironmentVariable("RH_MASCOT_DIR");
            if (!string.IsNullOrEmpty(over)) return over;
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".remote-hands", "mascot");
        }

        void StartMascot()
        {
            MascotForm made = new MascotForm(MascotDir());
            if (!made.Available)
            {
                made.Dispose();
                return;
            }
            made.CloseRequested = Cancel;
            mascot = made;
            made.Show(this);
            PlaceMascot();
            made.Start();
        }

        /// <summary>On top of the prompt while it is small; at the head of the column once the cards show.</summary>
        void PlaceMascot()
        {
            if (mascot == null) return;
            if (state.IsExpanded)
            {
                mascot.Stand(Left + Dpi.S(210), columnTop + Dpi.S(140), Dpi.S(140));
            }
            else
            {
                mascot.Stand(Left + Width / 2, Top - Dpi.S(4), Dpi.S(140));
            }
        }

        /// <summary>Distance from the top of the column (the mascot's head) to the top of the prompt pill.</summary>
        int PillOffset()
        {
            if (cards == null) return Dpi.S(144);
            return Dpi.S(144) - cards.EdgeMargin + cards.FormHeight - cards.EdgeMargin + Dpi.S(8);
        }

        /// <summary>
        /// Top to bottom: mascot, toolbar, the cards (as tall as the screen allows), then the pill for the next message.
        /// </summary>
        void ArrangeColumn()
        {
            if (cards == null || arranging) return;
            arranging = true;
            try
            {
                Rectangle wa = WorkArea();
                int cardsTop = columnTop + Dpi.S(144) - cards.EdgeMargin;
                int viewTop = cardsTop + cards.EdgeMargin + cards.BarHeight + Dpi.S(8);
                int room = wa.Bottom - Dpi.S(16) - Height - Dpi.S(8) - viewTop;
                cards.SetMaxViewport(CardStack.MaxHeight(room));
                cards.PlaceAt(Left + Dpi.S(210) - cards.FormWidth / 2, cardsTop);
                Top = columnTop + PillOffset();
                PlaceMascot();
            }
            finally
            {
                arranging = false;
            }
        }

        /// <summary>Dragging the pill moves the whole column with it.</summary>
        void OnMoved()
        {
            if (arranging) return;
            if (state.IsExpanded)
            {
                columnTop = Top - PillOffset();
                ArrangeColumn();
            }
            else
            {
                PlaceMascot();
            }
        }

        void OnInputChanged(object sender, EventArgs e)
        {
            LayoutPill();
            sendButton.Ready = input.Text.Trim().Length > 0;
            if (mascot != null && !state.IsExpanded)
            {
                mascot.TypedLength = input.Text.Length;
                mascot.SetMood(input.Text.Length == 0 ? Mood.Idle : Mood.Typing);
            }
        }

        void OnInputKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Enter && !e.Shift)
            {
                e.SuppressKeyPress = true;
                e.Handled = true;
                Submit();
            }
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape)
            {
                if (state.IsExpanded && state.IsWorking) Stop();
                else Cancel();
                return true;
            }
            if (keyData == (Keys.Control | Keys.OemPeriod))
            {
                Stop();
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }

        void Submit()
        {
            string text = input.Text.Trim();
            if (text.Length == 0) return;
            input.Text = "";
            Wire.Send(Messages.Submit(text, args.App, args.WindowTitle, args.Models.Count > 0 ? modelKey : ""));
            if (args.Once)
            {
                Thread.Sleep(50);
                Environment.Exit(0);
            }
            bool first = !state.IsExpanded;
            state.Submitted();
            if (first) TransitionToProgress();
            AppendEntry(EntryKind.Goal, text);
            ApplyChrome();
            SetPlaceholder("Type a follow-up, or press Esc to stop");
        }

        void TransitionToProgress()
        {
            Rectangle wa = WorkArea();
            columnTop = Math.Max(wa.Top + Dpi.S(8), Top - Dpi.S(4) - Dpi.S(140));
            cards = new CardsForm(Dpi.S(420));
            cards.StopRequested += Stop;
            cards.CloseRequested += Cancel;
            cards.FollowUpRequested += FocusPill;
            cards.CopyRequested += CopyAnswer;
            cards.LayoutChanged += ArrangeColumn;
            cards.Show(this);
            cards.Start();
            ArrangeColumn();
            input.Focus();
        }

        void FocusPill()
        {
            Native.ForceForeground(Handle);
            Activate();
            input.Focus();
        }

        void Stop()
        {
            if (!state.IsExpanded || !state.IsWorking) return;
            Wire.Send(Messages.Stop());
            AppendEntry(state.StopClicked().Kind, "Stopped.");
            ApplyChrome();
            input.Focus();
        }

        void Cancel()
        {
            if (closing) return;
            closing = true;
            Wire.Send(Messages.Cancel());
            Thread.Sleep(50);
            Environment.Exit(0);
        }

        void CopyAnswer()
        {
            if (state.AnswerText.Length == 0) return;
            try
            {
                Clipboard.SetText(state.AnswerText);
                if (cards != null) cards.FlashCopied();
            }
            catch (Exception)
            {
                // another program is holding the clipboard: the person can try again
            }
        }

        // ---- model choice --------------------------------------------------------------------

        void UpdateModelButton()
        {
            string label = "";
            foreach (ModelOption m in args.Models)
            {
                if (m.Key == modelKey) label = m.Label;
            }
            if (label.Length == 0 && args.Models.Count > 0) label = args.Models[0].Label;
            tips.SetToolTip(modelGlyph, "Model: " + label);
        }

        void OnModelClicked(object sender, EventArgs e)
        {
            modelMenu.Items.Clear();
            modelMenu.BackColor = Theme.Field;
            modelMenu.ForeColor = Theme.Text;
            modelMenu.ShowCheckMargin = true;
            foreach (ModelOption m in args.Models)
            {
                var item = new ToolStripMenuItem(m.Label);
                item.Tag = m.Key;
                item.Checked = m.Key == modelKey;
                item.BackColor = Theme.Field;
                item.ForeColor = Theme.Text;
                item.Click += OnModelPicked;
                modelMenu.Items.Add(item);
            }
            modelMenu.Show(modelGlyph, new Point(0, modelGlyph.Height));
        }

        void OnModelPicked(object sender, EventArgs e)
        {
            var item = sender as ToolStripMenuItem;
            if (item == null) return;
            string key = item.Tag as string;
            if (key == null || key == modelKey) return;
            modelKey = key;
            UpdateModelButton();
            Wire.Send(Messages.Model(key));
            input.Focus();
        }

        // ---- the daemon's messages -----------------------------------------------------------

        void ReadDaemon()
        {
            try
            {
                StreamReader reader = Wire.Input();
                string line;
                while ((line = reader.ReadLine()) != null)
                {
                    string copy = line;
                    try
                    {
                        BeginInvoke(new Action(delegate { HandleLine(copy); }));
                    }
                    catch (Exception)
                    {
                        return; // the window is gone
                    }
                }
            }
            catch (Exception)
            {
                // input broke: same as the daemon going away
            }
            // The daemon ended: nothing is left to talk to, so the window goes too.
            Environment.Exit(0);
        }

        void HandleLine(string line)
        {
            string trimmed = line.Trim();
            if (trimmed.Length == 0) return;
            var message = Json.Parse(trimmed) as Dictionary<string, object>;
            if (message == null) return;
            if (Json.GetString(message, "event") == "context") return; // browser tabs and files to attach: not on Windows yet
            UpdateResult result = state.Apply(Json.GetString(message, "status"), Json.GetString(message, "text"), Json.GetString(message, "role"));
            if (result.Ignored) return;
            foreach (FeedEntry entry in result.Entries) AppendEntry(entry.Kind, entry.Text);
            ApplyChrome();
            if (result.GiveInputBack) input.Focus();
        }

        void ApplyChrome()
        {
            if (!state.IsExpanded) return;
            if (mascot != null) mascot.SetMood(MascotBrain.MoodFor(state.IsWorking, state.StatusTone));
            if (cards != null)
            {
                cards.SetStatus(state.StatusWord, Theme.ForTone(state.StatusTone), state.IsWorking);
                cards.SetCopyReady(state.CopyVisible);
            }
            SetPlaceholder(state.IsWorking ? "Type a follow-up, or press Esc to stop" : "Ask a follow-up, or press Esc to close");
        }

        // ---- the cards -----------------------------------------------------------------------

        void AppendEntry(EntryKind kind, string rawText)
        {
            string text = rawText == null ? "" : rawText.Trim();
            if (text.Length == 0 || cards == null) return;
            cards.AddEntry(new FeedEntry(kind, text), state.IsWorking);
        }
    }

    /// <summary>Waits for the hotkey and says which program was in front.</summary>
    sealed class HotkeyWindow : NativeWindow
    {
        DateTime last = DateTime.MinValue;
        string keys = "";

        public bool Register()
        {
            var cp = new CreateParams();
            cp.Parent = Native.HWND_MESSAGE;
            CreateHandle(cp);
            if (Native.RegisterHotKey(Handle, 1, Native.MOD_CONTROL | Native.MOD_SHIFT | Native.MOD_NOREPEAT, Native.VK_SPACE))
            {
                keys = "Ctrl+Shift+Space";
                return true;
            }
            // another program holds the first choice: take the next one rather than do nothing
            if (Native.RegisterHotKey(Handle, 2, Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_NOREPEAT, Native.VK_SPACE))
            {
                keys = "Ctrl+Alt+Space";
                return true;
            }
            return false;
        }

        public string Keys { get { return keys; } }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY) OnHotkey();
            base.WndProc(ref m);
        }

        void OnHotkey()
        {
            if ((DateTime.UtcNow - last).TotalMilliseconds < 500) return;
            last = DateTime.UtcNow;
            // This program just received the keypress, so Windows lets it hand the keyboard to the prompt window that follows.
            try
            {
                Native.AllowSetForegroundWindow(-1);
            }
            catch (Exception)
            {
                // the prompt asks for the keyboard itself, with the Alt-tap fallback
            }
            string app = "Desktop";
            string title = "";
            try
            {
                IntPtr fg = Native.GetForegroundWindow();
                uint pid;
                Native.GetWindowThreadProcessId(fg, out pid);
                if (pid != 0 && pid != (uint)Process.GetCurrentProcess().Id)
                {
                    using (Process p = Process.GetProcessById((int)pid))
                    {
                        app = AppNames.Friendly(p.ProcessName);
                    }
                    var sb = new StringBuilder(512);
                    Native.GetWindowText(fg, sb, sb.Capacity);
                    title = sb.ToString();
                }
            }
            catch (Exception)
            {
                // a program that cannot be inspected is just "Desktop"
            }
            Wire.Send(Messages.Hotkey(app, title));
        }
    }

    /// <summary>Starts at login, runs the daemon's listener with no console window, and starts it again if it stops.</summary>
    static class Supervisor
    {
        static string HomeDir()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".remote-hands");
        }

        static string LogLine(string text)
        {
            return DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + text;
        }

        static void Log(string text)
        {
            try
            {
                string dir = Path.Combine(HomeDir(), "logs");
                Directory.CreateDirectory(dir);
                string file = Path.Combine(dir, "hud.log");
                lock (typeof(Supervisor))
                {
                    // the log never grows without end: start over once it is large
                    if (File.Exists(file) && new FileInfo(file).Length > 1000000) File.Delete(file);
                    File.AppendAllText(file, LogLine(text) + "\n", new UTF8Encoding(false));
                }
            }
            catch (Exception)
            {
                // logging must never stop the HUD
            }
        }

        /// <summary>What the listener said about its shortcut belongs to that listener: when it ends, "ready" is no longer true.</summary>
        static void ForgetReadyStatus()
        {
            try
            {
                string file = Path.Combine(HomeDir(), "hud-status.json");
                if (File.Exists(file) && File.ReadAllText(file, new UTF8Encoding(false)).IndexOf("\"ready\"", StringComparison.Ordinal) >= 0) File.Delete(file);
            }
            catch (Exception)
            {
                // the next listener overwrites it
            }
        }

        static SupervisorSettings ReadSettings(HudArgs args)
        {
            var settings = new SupervisorSettings();
            try
            {
                string file = Path.Combine(HomeDir(), "hud.json");
                if (File.Exists(file)) settings = SupervisorSettings.Parse(File.ReadAllText(file, new UTF8Encoding(false)));
            }
            catch (Exception)
            {
                // unreadable settings: the arguments (if any) decide
            }
            if (args.NodePath.Length > 0) settings.Node = args.NodePath;
            if (args.CliPath.Length > 0) settings.Cli = args.CliPath;
            return settings;
        }

        public static int Run(HudArgs args)
        {
            bool created;
            using (var mutex = new Mutex(true, "Local\\RemoteHandsHudSupervisor", out created))
            {
                if (!created) return 0; // already running
                try
                {
                    Directory.CreateDirectory(HomeDir());
                    File.WriteAllText(Path.Combine(HomeDir(), "hud-supervisor.pid"), Process.GetCurrentProcess().Id.ToString(), new UTF8Encoding(false));
                }
                catch (Exception)
                {
                    // `rh hud uninstall` then falls back to the registry entry only
                }
                int wait = 1000;
                while (true)
                {
                    DateTime started = DateTime.UtcNow;
                    SupervisorSettings settings = ReadSettings(args);
                    if (settings.Node.Length == 0 || settings.Cli.Length == 0)
                    {
                        Log("supervisor: no Node or CLI path is set (run: rh hud install)");
                    }
                    else
                    {
                        // A listener that ended no longer holds its shortcut. Nothing here ties the listener's descendants to this program
                        // (the browser window must survive a restart): helpers end when their own input closes.
                        ForgetReadyStatus();
                        try
                        {
                            var psi = new ProcessStartInfo(settings.Node);
                            psi.Arguments = "\"" + settings.Cli + "\" hud listen";
                            psi.UseShellExecute = false;
                            psi.CreateNoWindow = true;
                            psi.WindowStyle = ProcessWindowStyle.Hidden;
                            psi.RedirectStandardOutput = true;
                            psi.RedirectStandardError = true;
                            // The listener watches this open pipe: if this program ends for any reason, the pipe closes and the listener stops.
                            psi.RedirectStandardInput = true;
                            psi.EnvironmentVariables["RH_HUD_OWNER_PIPE"] = "1";
                            using (Process p = Process.Start(psi))
                            {
                                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log(e.Data); };
                                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) Log("error: " + e.Data); };
                                p.BeginOutputReadLine();
                                p.BeginErrorReadLine();
                                p.WaitForExit();
                                Log("listener ended with code " + p.ExitCode);
                            }
                        }
                        catch (Exception ex)
                        {
                            Log("listener could not start: " + ex.Message);
                        }
                        ForgetReadyStatus();
                    }
                    // a listener that ran for a while was healthy: start again quickly; one that dies at once waits longer
                    wait = (DateTime.UtcNow - started).TotalSeconds > 60 ? 1000 : Math.Min(wait * 2, 30000);
                    Thread.Sleep(wait);
                }
            }
        }
    }

    static class Program
    {
        [STAThread]
        static int Main(string[] argv)
        {
            HudArgs args = HudArgs.Parse(argv);
            if (args.Mode == "supervise") return Supervisor.Run(args);
            try
            {
                Native.SetProcessDPIAware();
            }
            catch (Exception)
            {
                // an older Windows: the window is simply scaled by the system
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Dpi.Init();
            if (args.Mode == "listen")
            {
                var window = new HotkeyWindow();
                if (!window.Register())
                {
                    Wire.Send(Messages.HotkeyFailed());
                    return 3;
                }
                Wire.Send(Messages.HotkeyReady(window.Keys));
                // The daemon keeps this program's input open: when that ends, the daemon is gone and so is the need for the hotkey.
                var watch = new Thread(delegate()
                {
                    try
                    {
                        StreamReader reader = Wire.Input();
                        while (reader.ReadLine() != null)
                        {
                        }
                    }
                    catch (Exception)
                    {
                        // treated as the end of the input
                    }
                    Environment.Exit(0);
                });
                watch.IsBackground = true;
                watch.Start();
                Application.Run();
                return 0;
            }
            Application.Run(new PromptForm(args));
            return 0;
        }
    }
}
