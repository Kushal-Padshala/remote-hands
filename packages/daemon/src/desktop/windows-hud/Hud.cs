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
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateRoundRectRgn(int x1, int y1, int x2, int y2, int cx, int cy);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
        [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [StructLayout(LayoutKind.Sequential)]
        public struct IoCounters { public ulong a, b, c, d, e, f; }
        [StructLayout(LayoutKind.Sequential)]
        public struct BasicLimits { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)]
        public struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

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

    /// <summary>The window: a prompt box that becomes a progress feed once a request is sent.</summary>
    sealed class PromptForm : Form
    {
        readonly HudArgs args;
        readonly HudState state = new HudState();
        string modelKey;

        readonly Label dot = new Label();
        readonly Label appName = new Label();
        readonly Label statusLabel = new Label();
        readonly Label spinner = new Label();
        readonly PillButton closeButton = new PillButton("\u2715", Theme.Secondary, Theme.ButtonFill);
        readonly PillButton stopButton = new PillButton("Stop", Theme.Danger, Color.FromArgb(48, 20, 20));
        readonly PillButton copyButton = new PillButton("Copy", Theme.Text, Theme.ButtonFill);
        readonly PillButton modelButton = new PillButton("", Theme.Secondary, Theme.ButtonFill);
        readonly TextBox input = new TextBox();
        readonly RoundPanel inputBox = new RoundPanel();
        readonly Panel divider = new Panel();
        readonly RichTextBox feed = new RichTextBox();
        readonly System.Windows.Forms.Timer spin = new System.Windows.Forms.Timer();
        readonly System.Windows.Forms.Timer copyReset = new System.Windows.Forms.Timer();
        readonly ContextMenuStrip modelMenu = new ContextMenuStrip();
        int spinFrame;
        int answerStart = -1;
        bool closing;
        const string SpinFrames = "\u25D0\u25D3\u25D1\u25D2";
        readonly Font fontSmall = new Font("Segoe UI Semibold", 8f);
        readonly Font fontNormal = new Font("Segoe UI", 10f);
        readonly Font fontMedium = new Font("Segoe UI Semibold", 11f);
        readonly Font fontAnswer = new Font("Segoe UI", 10.5f);

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

            dot.Text = "\u25CF";
            dot.ForeColor = Theme.Accent;
            dot.Font = new Font("Segoe UI", 7f);
            dot.AutoSize = true;
            appName.Text = args.App;
            appName.ForeColor = Theme.Secondary;
            appName.Font = new Font("Segoe UI Semibold", 9.5f);
            appName.AutoSize = true;
            statusLabel.ForeColor = Theme.Accent;
            statusLabel.Font = new Font("Segoe UI Semibold", 9.5f);
            statusLabel.AutoSize = true;
            statusLabel.Visible = false;
            spinner.ForeColor = Theme.Accent;
            spinner.Font = new Font("Segoe UI Symbol", 10f);
            spinner.AutoSize = true;
            spinner.Visible = false;

            input.BorderStyle = BorderStyle.None;
            input.BackColor = Theme.Background;
            input.ForeColor = Theme.Text;
            input.Font = new Font("Segoe UI", 15f);

            divider.BackColor = Theme.Divider;
            divider.Visible = false;

            feed.ReadOnly = true;
            feed.BorderStyle = BorderStyle.None;
            feed.BackColor = Theme.Background;
            feed.ForeColor = Theme.Text;
            feed.Font = new Font("Segoe UI", 10.5f);
            feed.DetectUrls = true;
            feed.TabStop = false;
            feed.Visible = false;
            feed.ScrollBars = RichTextBoxScrollBars.Vertical;
            feed.LinkClicked += OnLinkClicked;
            feed.Cursor = Cursors.IBeam;

            inputBox.Visible = false;

            closeButton.Click += delegate { Cancel(); };
            stopButton.Click += delegate { Stop(); };
            stopButton.Visible = false;
            copyButton.Click += delegate { CopyAnswer(); };
            copyButton.Visible = false;
            modelButton.Click += OnModelClicked;
            modelButton.Visible = args.Models.Count > 0;
            modelButton.TextAlign = ContentAlignment.MiddleCenter;
            UpdateModelButton();

            spin.Interval = 110;
            spin.Tick += delegate
            {
                spinFrame = (spinFrame + 1) % SpinFrames.Length;
                spinner.Text = SpinFrames[spinFrame].ToString();
            };
            copyReset.Interval = 1600;
            copyReset.Tick += delegate
            {
                copyReset.Stop();
                copyButton.Text = "Copy";
                copyButton.ForeColor = Theme.Text;
            };

            Controls.Add(dot);
            Controls.Add(appName);
            Controls.Add(statusLabel);
            Controls.Add(spinner);
            Controls.Add(closeButton);
            Controls.Add(stopButton);
            Controls.Add(copyButton);
            Controls.Add(divider);
            Controls.Add(feed);
            Controls.Add(inputBox);
            Controls.Add(modelButton);
            Controls.Add(input);

            // Every part of the window except the controls drags it.
            MouseDown += DragWindow;
            dot.MouseDown += DragWindow;
            appName.MouseDown += DragWindow;
            statusLabel.MouseDown += DragWindow;

            input.KeyDown += OnInputKeyDown;
            Layout_Collapsed();
            ResumeLayout(false);
        }

        // ---- layout ------------------------------------------------------------------------

        Rectangle WorkArea()
        {
            return Screen.FromPoint(Cursor.Position).WorkingArea;
        }

        void ApplyRegion()
        {
            if (Width <= 0 || Height <= 0) return;
            Region = Region.FromHrgn(Native.CreateRoundRectRgn(0, 0, Width + 1, Height + 1, Dpi.S(36), Dpi.S(36)));
        }

        void Layout_Collapsed()
        {
            int w = Dpi.S(680), h = Dpi.S(84);
            Rectangle wa = WorkArea();
            Bounds = new Rectangle(wa.Left + (wa.Width - w) / 2, wa.Top + (int)(wa.Height * 0.28), w, h);
            ApplyRegion();
            dot.Location = new Point(Dpi.S(24), Dpi.S(15));
            appName.Location = new Point(Dpi.S(38), Dpi.S(11));
            closeButton.Bounds = new Rectangle(w - Dpi.S(44), Dpi.S(10), Dpi.S(26), Dpi.S(24));
            int pill = modelButton.Visible ? Dpi.S(214) : 0;
            input.Font = new Font("Segoe UI", 15f);
            input.Bounds = new Rectangle(Dpi.S(24), Dpi.S(40), w - Dpi.S(48) - pill, Dpi.S(30));
            modelButton.Bounds = new Rectangle(w - Dpi.S(24) - Dpi.S(206), Dpi.S(40), Dpi.S(206), Dpi.S(26));
            Invalidate();
        }

        void Layout_Expanded()
        {
            Rectangle wa = WorkArea();
            int w = Dpi.S(640);
            int h = Math.Min(Dpi.S(600), Math.Max(Dpi.S(420), wa.Height - Dpi.S(80)));
            Bounds = new Rectangle(wa.Right - w - Dpi.S(24), wa.Top + Dpi.S(24), w, h);
            ApplyRegion();
            dot.Location = new Point(Dpi.S(22), Dpi.S(19));
            appName.Location = new Point(Dpi.S(36), Dpi.S(15));
            int statusX = appName.Right + Dpi.S(20);
            spinner.Location = new Point(statusX, Dpi.S(14));
            statusLabel.Location = new Point(statusX + Dpi.S(22), Dpi.S(15));
            closeButton.Bounds = new Rectangle(w - Dpi.S(44), Dpi.S(12), Dpi.S(26), Dpi.S(24));
            stopButton.Bounds = new Rectangle(w - Dpi.S(118), Dpi.S(12), Dpi.S(64), Dpi.S(24));
            copyButton.Bounds = stopButton.Bounds;
            divider.Bounds = new Rectangle(0, Dpi.S(52), w, 1);
            int boxH = Dpi.S(44);
            inputBox.Bounds = new Rectangle(Dpi.S(16), h - Dpi.S(16) - boxH, w - Dpi.S(32), boxH);
            int feedTop = Dpi.S(60);
            int feedBottom = h - Dpi.S(16) - boxH - Dpi.S(12);
            feed.Bounds = new Rectangle(Dpi.S(22), feedTop, w - Dpi.S(44), feedBottom - feedTop);
            int pill = modelButton.Visible ? Dpi.S(214) : 0;
            input.Font = new Font("Segoe UI", 11.5f);
            input.BackColor = Theme.Field;
            // the text box and model button sit inside the rounded input box
            input.Bounds = new Rectangle(inputBox.Left + Dpi.S(16), inputBox.Top + Dpi.S(12), inputBox.Width - Dpi.S(32) - pill, Dpi.S(22));
            modelButton.Bounds = new Rectangle(inputBox.Right - Dpi.S(10) - Dpi.S(206), inputBox.Top + Dpi.S(9), Dpi.S(206), Dpi.S(26));
            inputBox.Visible = true;
            divider.Visible = true;
            feed.Visible = true;
            statusLabel.Visible = true;
            input.BringToFront();
            modelButton.BringToFront();
            closeButton.BringToFront();
            stopButton.BringToFront();
            copyButton.BringToFront();
            Invalidate();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Shapes.Rounded(new Rectangle(0, 0, Width - 1, Height - 1), Dpi.S(18)))
            using (var pen = new Pen(Theme.Border))
            {
                e.Graphics.DrawPath(pen, path);
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
            SetPlaceholder("Ask anything\u2026");
            input.Focus();
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
            SuspendLayout();
            Layout_Expanded();
            appName.Text = args.App;
            ResumeLayout(true);
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
                copyButton.Text = "Copied";
                copyButton.ForeColor = Theme.Success;
                copyReset.Stop();
                copyReset.Start();
            }
            catch (Exception)
            {
                // another program is holding the clipboard: the button stays "Copy" and the person can try again
            }
        }

        void OnLinkClicked(object sender, LinkClickedEventArgs e)
        {
            // Only web and mail links open: a file path or a program in the agent's text never does.
            if (!Links.IsOpenable(e.LinkText)) return;
            try
            {
                Process.Start(new ProcessStartInfo(e.LinkText.Trim()) { UseShellExecute = true });
            }
            catch (Exception)
            {
                // no program for that kind of link
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
            modelButton.Text = label + "  \u25BE";
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
            modelMenu.Show(modelButton, new Point(0, modelButton.Height));
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
            statusLabel.Text = state.StatusWord;
            statusLabel.ForeColor = Theme.ForTone(state.StatusTone);
            spinner.Visible = state.IsWorking;
            if (state.IsWorking) { if (!spin.Enabled) spin.Start(); } else spin.Stop();
            stopButton.Visible = state.StopVisible;
            copyButton.Visible = state.CopyVisible;
            if (state.CopyVisible)
            {
                copyReset.Stop();
                copyButton.Text = "Copy";
                copyButton.ForeColor = Theme.Text;
            }
            SetPlaceholder(state.IsWorking ? "Type a follow-up, or press Esc to stop" : "Ask a follow-up, or press Esc to close");
        }

        // ---- the feed ------------------------------------------------------------------------

        void Append(string text, Color color, Font font)
        {
            feed.SelectionStart = feed.TextLength;
            feed.SelectionLength = 0;
            feed.SelectionColor = color;
            feed.SelectionFont = font;
            feed.AppendText(text);
        }

        void AppendEntry(EntryKind kind, string rawText)
        {
            string text = rawText == null ? "" : rawText.Trim();
            if (text.Length == 0) return;
            bool first = feed.TextLength == 0;
            Font small = fontSmall;
            Font normal = fontNormal;
            Font medium = fontMedium;
            Font answerFont = fontAnswer;
            int start = feed.TextLength;
            switch (kind)
            {
                case EntryKind.Goal:
                    Append((first ? "" : "\n") + "YOU\n", Theme.Tertiary, small);
                    Append(text + "\n", Theme.Text, medium);
                    break;
                case EntryKind.Step:
                    Append("\u2713  ", Theme.Success, normal);
                    Append(text + "\n", Theme.Secondary, normal);
                    break;
                case EntryKind.Note:
                    Append("\u00B7  ", Theme.Tertiary, normal);
                    Append(text + "\n", Theme.Tertiary, normal);
                    break;
                case EntryKind.Attention:
                    Append("!  ", Theme.Warning, medium);
                    Append(text + "\n", Theme.Warning, normal);
                    break;
                case EntryKind.Error:
                    Append("\u2715  ", Theme.Danger, medium);
                    Append(text + "\n", Theme.Danger, normal);
                    break;
                default:
                    Append((first ? "" : "\n") + "RESULT\n", Theme.Success, small);
                    answerStart = feed.TextLength;
                    Append(text + "\n", Theme.Text, answerFont);
                    break;
            }
            if (kind == EntryKind.Answer)
            {
                // a long answer is read from its first line
                feed.SelectionStart = feed.TextLength;
                feed.ScrollToCaret();
                feed.SelectionStart = Math.Max(0, answerStart);
                feed.ScrollToCaret();
            }
            else
            {
                feed.SelectionStart = feed.TextLength;
                feed.ScrollToCaret();
            }
            feed.SelectionLength = 0;
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

        /// <summary>A job that ends everything started inside it when it is closed; null when Windows will not make one.</summary>
        static IntPtr MakeJob()
        {
            IntPtr job = IntPtr.Zero;
            try
            {
                job = Native.CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) return IntPtr.Zero;
                var info = new Native.ExtendedLimits();
                info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                int size = Marshal.SizeOf(typeof(Native.ExtendedLimits));
                IntPtr ptr = Marshal.AllocHGlobal(size);
                try
                {
                    Marshal.StructureToPtr(info, ptr, false);
                    if (!Native.SetInformationJobObject(job, 9, ptr, (uint)size)) // JobObjectExtendedLimitInformation
                    {
                        Native.CloseHandle(job);
                        return IntPtr.Zero;
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(ptr);
                }
                return job;
            }
            catch (Exception)
            {
                if (job != IntPtr.Zero) Native.CloseHandle(job);
                return IntPtr.Zero;
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
                        // one job for each attempt: whatever the listener left behind is ended before the next one starts
                        IntPtr job = MakeJob();
                        try
                        {
                            var psi = new ProcessStartInfo(settings.Node);
                            psi.Arguments = "\"" + settings.Cli + "\" hud listen";
                            psi.UseShellExecute = false;
                            psi.CreateNoWindow = true;
                            psi.WindowStyle = ProcessWindowStyle.Hidden;
                            psi.RedirectStandardOutput = true;
                            psi.RedirectStandardError = true;
                            using (Process p = Process.Start(psi))
                            {
                                if (job != IntPtr.Zero) Native.AssignProcessToJobObject(job, p.Handle);
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
                        finally
                        {
                            if (job != IntPtr.Zero) Native.CloseHandle(job); // ends any helper the listener left running
                        }
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
