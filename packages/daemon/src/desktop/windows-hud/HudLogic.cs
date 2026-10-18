// Remote Hands Windows HUD: the parts that do not draw anything (protocol, JSON, state), kept free of
// System.Windows.Forms so they can be compiled and tested on any computer. C# 5 only: this is built on the
// user's PC by the compiler that ships with Windows (csc.exe, C# 5), so no ?., $"", nameof or expression bodies.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace RemoteHands
{
    /// <summary>A small JSON reader and writer: enough for the lines this program exchanges with the daemon.</summary>
    public static class Json
    {
        /// <summary>Parses one JSON value. Objects are Dictionary&lt;string, object&gt;, arrays List&lt;object&gt;, numbers double.</summary>
        /// <returns>null when the text is not valid JSON (the caller ignores that line).</returns>
        public static object Parse(string text)
        {
            if (text == null) return null;
            try
            {
                int i = 0;
                SkipSpace(text, ref i);
                object value = ReadValue(text, ref i, 0);
                SkipSpace(text, ref i);
                if (i != text.Length) return null;
                return value;
            }
            catch (FormatException)
            {
                return null;
            }
        }

        static void SkipSpace(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) i++;
        }

        static object ReadValue(string s, ref int i, int depth)
        {
            if (depth > 64) throw new FormatException("too deep");
            if (i >= s.Length) throw new FormatException("unexpected end");
            char c = s[i];
            if (c == '{') return ReadObject(s, ref i, depth);
            if (c == '[') return ReadArray(s, ref i, depth);
            if (c == '"') return ReadString(s, ref i);
            if (c == 't') { Expect(s, ref i, "true"); return true; }
            if (c == 'f') { Expect(s, ref i, "false"); return false; }
            if (c == 'n') { Expect(s, ref i, "null"); return null; }
            return ReadNumber(s, ref i);
        }

        static void Expect(string s, ref int i, string word)
        {
            if (string.CompareOrdinal(s, i, word, 0, word.Length) != 0) throw new FormatException("bad literal");
            i += word.Length;
        }

        static object ReadNumber(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
            double d;
            if (i == start || !double.TryParse(s.Substring(start, i - start), NumberStyles.Float, CultureInfo.InvariantCulture, out d))
                throw new FormatException("bad number");
            return d;
        }

        static Dictionary<string, object> ReadObject(string s, ref int i, int depth)
        {
            var result = new Dictionary<string, object>();
            i++; // {
            SkipSpace(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return result; }
            while (true)
            {
                SkipSpace(s, ref i);
                if (i >= s.Length || s[i] != '"') throw new FormatException("expected key");
                string key = ReadString(s, ref i);
                SkipSpace(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("expected colon");
                i++;
                SkipSpace(s, ref i);
                result[key] = ReadValue(s, ref i, depth + 1);
                SkipSpace(s, ref i);
                if (i >= s.Length) throw new FormatException("unexpected end");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return result; }
                throw new FormatException("expected , or }");
            }
        }

        static List<object> ReadArray(string s, ref int i, int depth)
        {
            var result = new List<object>();
            i++; // [
            SkipSpace(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return result; }
            while (true)
            {
                SkipSpace(s, ref i);
                result.Add(ReadValue(s, ref i, depth + 1));
                SkipSpace(s, ref i);
                if (i >= s.Length) throw new FormatException("unexpected end");
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return result; }
                throw new FormatException("expected , or ]");
            }
        }

        static string ReadString(string s, ref int i)
        {
            var sb = new StringBuilder();
            i++; // opening quote
            while (true)
            {
                if (i >= s.Length) throw new FormatException("unterminated string");
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) throw new FormatException("unterminated escape");
                char e = s[i++];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (i + 4 > s.Length) throw new FormatException("bad unicode escape");
                        int code;
                        if (!int.TryParse(s.Substring(i, 4), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out code))
                            throw new FormatException("bad unicode escape");
                        sb.Append((char)code);
                        i += 4;
                        break;
                    default: throw new FormatException("bad escape");
                }
            }
        }

        /// <summary>A string as a JSON literal, with everything that could break a one-line message escaped.</summary>
        public static string Quote(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < ' ' || c == '\u2028' || c == '\u2029') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string GetString(object obj, string key)
        {
            var d = obj as Dictionary<string, object>;
            object v;
            if (d == null || !d.TryGetValue(key, out v)) return null;
            return v as string;
        }
    }

    public sealed class ModelOption
    {
        public string Key;
        public string Label;
        public ModelOption(string key, string label) { Key = key; Label = label; }
    }

    /// <summary>The command line: `listen`, or `prompt --app=X --window-title=T --models=JSON --model=KEY`.</summary>
    public sealed class HudArgs
    {
        public string Mode = "prompt";
        public string App = "Desktop";
        public string WindowTitle = "";
        public List<ModelOption> Models = new List<ModelOption>();
        public string ModelKey = "";
        public string NodePath = "";
        public string CliPath = "";
        /// <summary>One-shot prompt: print the first request and exit, never reading the daemon's messages.</summary>
        public bool Once;

        public static HudArgs Parse(string[] args)
        {
            var result = new HudArgs();
            if (args == null) return result;
            foreach (string arg in args)
            {
                if (arg == null) continue;
                if (arg == "listen") result.Mode = "listen";
                else if (arg == "supervise") result.Mode = "supervise";
                else if (arg == "--once") result.Once = true;
                else if (arg.StartsWith("--app=", StringComparison.Ordinal)) result.App = arg.Substring(6);
                else if (arg.StartsWith("--window-title=", StringComparison.Ordinal)) result.WindowTitle = arg.Substring(15);
                else if (arg.StartsWith("--model=", StringComparison.Ordinal)) result.ModelKey = arg.Substring(8);
                else if (arg.StartsWith("--node=", StringComparison.Ordinal)) result.NodePath = arg.Substring(7);
                else if (arg.StartsWith("--cli=", StringComparison.Ordinal)) result.CliPath = arg.Substring(6);
                else if (arg.StartsWith("--models=", StringComparison.Ordinal))
                {
                    var list = Json.Parse(arg.Substring(9)) as List<object>;
                    if (list == null) continue;
                    foreach (object item in list)
                    {
                        string key = Json.GetString(item, "key");
                        string label = Json.GetString(item, "label");
                        if (!string.IsNullOrEmpty(key) && !string.IsNullOrEmpty(label)) result.Models.Add(new ModelOption(key, label));
                    }
                }
            }
            if (result.App.Length == 0) result.App = "Desktop";
            return result;
        }
    }

    /// <summary>The lines this program prints for the daemon.</summary>
    public static class Messages
    {
        public static string Submit(string query, string app, string windowTitle, string modelKey)
        {
            var sb = new StringBuilder();
            sb.Append("{\"event\":\"submit\",\"query\":").Append(Json.Quote(query));
            sb.Append(",\"app\":").Append(Json.Quote(app));
            if (!string.IsNullOrEmpty(windowTitle)) sb.Append(",\"windowTitle\":").Append(Json.Quote(windowTitle));
            if (!string.IsNullOrEmpty(modelKey)) sb.Append(",\"model\":").Append(Json.Quote(modelKey));
            sb.Append('}');
            return sb.ToString();
        }

        public static string Model(string modelKey) { return "{\"event\":\"model\",\"model\":" + Json.Quote(modelKey) + "}"; }
        public static string Stop() { return "{\"event\":\"stop\"}"; }
        public static string Cancel() { return "{\"event\":\"cancel\"}"; }

        public static string Hotkey(string app, string windowTitle)
        {
            return "{\"event\":\"hotkey\",\"app\":" + Json.Quote(app) + ",\"windowTitle\":" + Json.Quote(windowTitle) + "}";
        }

        /// <summary>Tells the daemon which keys the hotkey ended up on (another program may hold the first choice).</summary>
        public static string HotkeyReady(string keys) { return "{\"event\":\"hotkey-ready\",\"keys\":" + Json.Quote(keys) + "}"; }
        public static string HotkeyFailed() { return "{\"event\":\"hotkey-failed\"}"; }
    }

    /// <summary>The supervisor's settings, written by `rh hud install` so the login entry itself stays short.</summary>
    public sealed class SupervisorSettings
    {
        public string Node = "";
        public string Cli = "";

        public static SupervisorSettings Parse(string json)
        {
            var result = new SupervisorSettings();
            object parsed = Json.Parse(json);
            string node = Json.GetString(parsed, "node");
            string cli = Json.GetString(parsed, "cli");
            if (!string.IsNullOrEmpty(node)) result.Node = node;
            if (!string.IsNullOrEmpty(cli)) result.Cli = cli;
            return result;
        }
    }

    public enum EntryKind { Goal, Step, Attention, Error, Answer, Note }

    public enum Tone { Accent, Success, Warning, Danger }

    public sealed class FeedEntry
    {
        public EntryKind Kind;
        public string Text;
        public FeedEntry(EntryKind kind, string text) { Kind = kind; Text = text; }
    }

    /// <summary>What the window should show after a message from the daemon.</summary>
    public sealed class UpdateResult
    {
        public List<FeedEntry> Entries = new List<FeedEntry>();
        public bool Ignored;
        public bool GiveInputBack;
    }

    /// <summary>
    /// The state of the progress window and how it follows the daemon's messages. The rules are those of the Mac window:
    /// a finished task never gets its spinner back, a failed one gives the input back, and so on.
    /// </summary>
    public sealed class HudState
    {
        public bool IsWorking;
        public bool IsExpanded;
        public string StatusWord = "";
        public Tone StatusTone = Tone.Accent;
        public bool StopVisible;
        public bool CopyVisible;
        public string AnswerText = "";

        /// <summary>The person pressed Enter on a request.</summary>
        public void Submitted()
        {
            IsExpanded = true;
            IsWorking = true;
            StatusWord = "Starting";
            StatusTone = Tone.Accent;
            StopVisible = true;
            CopyVisible = false;
            AnswerText = "";
        }

        /// <summary>The person pressed Stop (or Esc while working).</summary>
        public FeedEntry StopClicked()
        {
            IsWorking = false;
            StatusWord = "Stopped";
            StatusTone = Tone.Warning;
            StopVisible = false;
            return new FeedEntry(EntryKind.Note, "Stopped.");
        }

        /// <summary>"READING" in the protocol is "Reading" on screen.</summary>
        public static string DisplayStatus(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return "";
            string lower = raw.ToLowerInvariant();
            return char.ToUpperInvariant(lower[0]) + lower.Substring(1);
        }

        public UpdateResult Apply(string status, string text, string role)
        {
            var result = new UpdateResult();
            string up = string.IsNullOrEmpty(status) ? "WORKING" : status.ToUpperInvariant();
            string body = text == null ? "" : text;
            if (up == "COMPLETE" || up == "DONE")
            {
                IsWorking = false;
                StatusWord = "Done";
                StatusTone = Tone.Success;
                StopVisible = false;
                string final = body.Trim();
                string shown = final.Length == 0 ? "Task completed successfully." : final;
                result.Entries.Add(new FeedEntry(EntryKind.Answer, shown));
                AnswerText = shown;
                CopyVisible = AnswerText.Length > 0;
                result.GiveInputBack = true;
            }
            else if (up == "STOPPED" || up == "CANCELLED")
            {
                if (IsWorking) result.Entries.Add(new FeedEntry(EntryKind.Note, body.Trim().Length == 0 ? "Stopped." : body.Trim()));
                IsWorking = false;
                StatusWord = "Stopped";
                StatusTone = Tone.Warning;
                StopVisible = false;
                result.GiveInputBack = true;
            }
            else if (up == "FAILED")
            {
                IsWorking = false;
                StatusWord = "Failed";
                StatusTone = Tone.Danger;
                StopVisible = false;
                result.Entries.Add(new FeedEntry(EntryKind.Error, body.Trim().Length == 0 ? "The task failed." : body.Trim()));
                result.GiveInputBack = true;
            }
            else if (up == "ERROR")
            {
                result.Entries.Add(new FeedEntry(EntryKind.Error, body.Trim().Length == 0 ? "Something went wrong." : body.Trim()));
            }
            else if (body.Length == 0 && !IsWorking)
            {
                // a status word that arrives after the task ended must not bring the spinner back
                result.Ignored = true;
            }
            else
            {
                IsWorking = true;
                StatusWord = DisplayStatus(up);
                StatusTone = Tone.Accent;
                StopVisible = true;
                CopyVisible = false;
                if (body.Trim().Length > 0)
                {
                    bool attention = role == "ATTENTION" || role == "PROBLEM";
                    result.Entries.Add(new FeedEntry(attention ? EntryKind.Attention : EntryKind.Step, body.Trim()));
                }
            }
            return result;
        }
    }

    public static class Links
    {
        /// <summary>Only web and mail links may be opened from the agent's text; a file path or a program must never be.</summary>
        public static bool IsOpenable(string url)
        {
            if (string.IsNullOrEmpty(url)) return false;
            Uri uri;
            if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out uri)) return false;
            string scheme = uri.Scheme.ToLowerInvariant();
            return scheme == "http" || scheme == "https" || scheme == "mailto";
        }
    }

    public static class AppNames
    {
        /// <summary>The name a person knows a program by, from its process name ("msedge" is Microsoft Edge).</summary>
        public static string Friendly(string processName)
        {
            if (string.IsNullOrEmpty(processName)) return "Desktop";
            string lower = processName.Trim().ToLowerInvariant();
            if (lower.EndsWith(".exe", StringComparison.Ordinal)) lower = lower.Substring(0, lower.Length - 4);
            switch (lower)
            {
                case "chrome": return "Google Chrome";
                case "msedge": return "Microsoft Edge";
                case "firefox": return "Firefox";
                case "brave": return "Brave Browser";
                case "opera": return "Opera";
                case "vivaldi": return "Vivaldi";
                case "arc": return "Arc";
                case "explorer": return "File Explorer";
                case "notepad": return "Notepad";
                case "winword": return "Microsoft Word";
                case "excel": return "Microsoft Excel";
                case "powerpnt": return "Microsoft PowerPoint";
                case "outlook": return "Microsoft Outlook";
                case "code": return "Visual Studio Code";
                case "slack": return "Slack";
                case "teams":
                case "ms-teams": return "Microsoft Teams";
                case "applicationframehost": return "Desktop";
                case "searchhost":
                case "startmenuexperiencehost":
                case "shellexperiencehost": return "Desktop";
            }
            return char.ToUpperInvariant(lower[0]) + lower.Substring(1);
        }
    }

    public enum Mood { Idle, Typing, Working, Happy, Error, Stopped }

    public enum Expression { Neutral, Listening, Happy, Content, Terminal, Focus, Thinking, Surprised, Sad, Error, Sleepy, Wink, Laugh, Smug }

    public enum EyeShape { Open, ArcUp, ArcDown, ChevronRight, ChevronLeft, Underscore, Cross }

    public enum MouthShape { Smile, Grin, O, Flat, Wave, Smirk }

    /// <summary>What one expression looks like: the shape of each eye and of the mouth, and a few tweaks (same as the Mac HUD).</summary>
    public sealed class FaceSpec
    {
        public EyeShape Left = EyeShape.Open;
        public EyeShape Right = EyeShape.Open;
        public double EyeWidth = 1;
        public double EyeHeight = 1;
        public double RightScale = 1;
        /// <summary>Degrees; the left eye turns this way, the right one the opposite way.</summary>
        public double Tilt;
        /// <summary>How much of the eye is covered from the top.</summary>
        public double Lid;
        public MouthShape Mouth = MouthShape.Smile;
        /// <summary>-1 frown ... 1 big smile.</summary>
        public double Curve = 0.5;
        public double MouthSize = 1;
        /// <summary>Drawn in red instead of cyan.</summary>
        public bool Warning;
        public bool Zzz;
        /// <summary>Where it looks whatever the cursor does (-1..1), or null.</summary>
        public double? ForcedGazeX;
        public double ForcedGazeY;

        public static FaceSpec Of(Expression e)
        {
            var s = new FaceSpec();
            switch (e)
            {
                case Expression.Listening: s.EyeWidth = 1.05; s.EyeHeight = 1.15; s.Curve = 0.65; break;
                case Expression.Happy: s.Left = EyeShape.ArcUp; s.Right = EyeShape.ArcUp; s.Mouth = MouthShape.Grin; s.MouthSize = 0.9; break;
                case Expression.Content: s.Left = EyeShape.ArcDown; s.Right = EyeShape.ArcDown; s.Curve = 0.8; break;
                case Expression.Terminal: s.Left = EyeShape.ChevronRight; s.Right = EyeShape.Underscore; s.Curve = 0.25; s.MouthSize = 0.8; break;
                case Expression.Focus: s.EyeHeight = 0.55; s.Mouth = MouthShape.Flat; break;
                case Expression.Thinking: s.EyeWidth = 0.9; s.RightScale = 1.25; s.Mouth = MouthShape.Wave; s.MouthSize = 0.95; s.ForcedGazeX = 0.8; s.ForcedGazeY = -0.9; break;
                case Expression.Surprised: s.EyeHeight = 1.4; s.EyeWidth = 1.12; s.Mouth = MouthShape.O; break;
                case Expression.Sad: s.EyeHeight = 0.9; s.Tilt = 15; s.Curve = -0.7; break;
                case Expression.Error: s.Left = EyeShape.Cross; s.Right = EyeShape.Cross; s.Mouth = MouthShape.Wave; s.Warning = true; break;
                case Expression.Sleepy: s.Left = EyeShape.ArcDown; s.Right = EyeShape.ArcDown; s.Mouth = MouthShape.O; s.MouthSize = 0.45; s.Zzz = true; break;
                case Expression.Wink: s.Right = EyeShape.ArcUp; s.Curve = 0.85; break;
                case Expression.Laugh: s.Left = EyeShape.ChevronRight; s.Right = EyeShape.ChevronLeft; s.Mouth = MouthShape.Grin; s.MouthSize = 1.15; break;
                case Expression.Smug: s.Lid = 0.5; s.Mouth = MouthShape.Smirk; s.Curve = 0.7; s.ForcedGazeX = 0.9; s.ForcedGazeY = 0; break;
            }
            return s;
        }
    }

    /// <summary>Where things are on the mascot's pictures, as fractions of the picture (assets/mascot/meta.json). Same numbers as `Face` in the Mac HUD.</summary>
    public static class Face
    {
        public const double VisorX0 = 0.2065, VisorY0 = 0.2192, VisorX1 = 0.6877, VisorY1 = 0.5100;
        public const double EyeLeftX = 0.3261, EyeRightX = 0.5464, EyeY = 0.3611;
        public const double EyeW = 0.0620, EyeH = 0.0760;
        public const double MouthX = 0.4341, MouthY = 0.4258;
        public const double PivotX = 0.4884, PivotY = 0.5466;
        public const double HeadShiftX = 0.035, HeadShiftY = 0.018, HeadTilt = 7.0;
        public const double GazeShiftX = 0.05, GazeShiftY = 0.03;
    }

    /// <summary>What the mascot looks like right now (one tick): the face, where it looks, how the head sits.</summary>
    public sealed class MascotPose
    {
        public Expression Shown = Expression.Neutral;
        public FaceSpec Spec = FaceSpec.Of(Expression.Neutral);
        public double Fade = 1;
        /// <summary>Eyes: 1 open ... 0 shut (a blink).</summary>
        public double Openness = 1;
        public double GazeX, GazeY;
        /// <summary>The head's offset as a fraction of the picture, and its tilt in degrees (clockwise is positive).</summary>
        public double HeadX, HeadY, HeadTilt;
        public bool CursorOn = true;
        public double ZPhase;

        /// <summary>Changes when anything that is drawn changes (so an idle mascot costs nothing).</summary>
        public string Key()
        {
            return Shown + "|" + (int)(Fade * 10) + "|" + (int)(Openness * 10) + "|" + (int)(GazeX * 20) + "|" + (int)(GazeY * 20) + "|" +
                   (int)(HeadX * 4000) + "|" + (int)(HeadY * 4000) + "|" + (int)(HeadTilt * 10) + "|" + CursorOn + "|" + (Spec.Zzz ? (int)(ZPhase * 30) : 0);
        }
    }

    /// <summary>
    /// What the mascot feels and does: the same rules as the Mac window. It follows the cursor with its eyes and its whole
    /// head, blinks, now and then makes a face when idle, looks down while someone types, shows a terminal prompt in its
    /// eyes while a task runs, and smiles, frowns or dozes when it ends. One tick is 50 ms.
    /// </summary>
    public sealed class MascotBrain
    {
        static readonly double[] BlinkOpenness = new double[] { 0.45, 0.06, 0.45 };
        static readonly int[] HopTable = new int[] { 0, 6, 11, 14, 11, 6, 0, 3, 5, 3, 0 };
        static readonly Expression[] Ambient = new Expression[] { Expression.Content, Expression.Smug, Expression.Wink, Expression.Laugh, Expression.Content };

        readonly Random rng;
        readonly List<KeyValuePair<Expression, int>> reactions = new List<KeyValuePair<Expression, int>>();
        readonly MascotPose pose = new MascotPose();
        int tick;
        int reactionLeft;
        int happyUntil;
        int hopStart = -1;
        int nextBlink = 50;
        int blinkStart = -1;
        int nextAmbient = 200;
        int ambientUntil;
        bool hasAmbient;
        Expression ambient = Expression.Neutral;
        int nextThought = 150;
        int thoughtUntil;
        int lastActivity;
        Expression wanted = Expression.Neutral;
        Mood mood = Mood.Idle;

        /// <summary>How much has been typed (a long request makes it concentrate).</summary>
        public int TypedLength;

        /// <param name="seed">for the timing of blinks and faces; tests pass a fixed one</param>
        public MascotBrain(int seed)
        {
            rng = new Random(seed);
        }

        public Mood Current { get { return mood; } }

        /// <summary>The pose as of the last tick.</summary>
        public MascotPose Latest() { return pose; }

        public void SetMood(Mood next)
        {
            if (next == mood) return;
            mood = next;
            lastActivity = tick;
            if (next == Mood.Happy)
            {
                happyUntil = tick + 80;
                hopStart = tick;
            }
        }

        /// <summary>A click or a hello: a short run of faces ahead of whatever the mood says.</summary>
        public void Play(Expression first, int firstTicks, Expression second, int secondTicks)
        {
            reactions.Clear();
            reactions.Add(new KeyValuePair<Expression, int>(first, firstTicks));
            if (secondTicks > 0) reactions.Add(new KeyValuePair<Expression, int>(second, secondTicks));
            reactionLeft = firstTicks;
        }

        /// <summary>A click: jump in surprise, then laugh.</summary>
        public void Poke()
        {
            Play(Expression.Surprised, 8, Expression.Laugh, 26);
            hopStart = tick;
        }

        public static Mood MoodFor(bool working, Tone tone)
        {
            if (working) return Mood.Working;
            switch (tone)
            {
                case Tone.Success: return Mood.Happy;
                case Tone.Danger: return Mood.Error;
                case Tone.Warning: return Mood.Stopped;
                default: return Mood.Idle;
            }
        }

        /// <summary>How high (in 96-dpi pixels) the little jump after a finished task has lifted it right now.</summary>
        public int HopOffset()
        {
            if (hopStart < 0) return 0;
            int i = tick - hopStart;
            if (i >= HopTable.Length)
            {
                hopStart = -1;
                return 0;
            }
            return HopTable[i];
        }

        /// <summary>
        /// Advances one tick. (lookX, lookY) is where the cursor is from the eyes, -1..1 each way (y grows downward);
        /// `activity` says the cursor moved since the last tick.
        /// </summary>
        public MascotPose Step(double lookX, double lookY, bool activity)
        {
            tick++;
            if (activity) lastActivity = tick;
            if (mood == Mood.Happy && tick >= happyUntil) mood = Mood.Idle;
            wanted = Wanted();
            FaceSpec spec = FaceSpec.Of(pose.Shown);

            double gazeX = lookX, gazeY = lookY;
            // typing: it reads along the text, from left to right as the request grows, looking down at it
            if (mood == Mood.Typing) { gazeX = Math.Min(0.8, -0.7 + TypedLength * 0.03); gazeY = 0.9; }
            if (spec.ForcedGazeX.HasValue) { gazeX = spec.ForcedGazeX.Value; gazeY = spec.ForcedGazeY; }
            pose.GazeX += (gazeX - pose.GazeX) * 0.4;
            pose.GazeY += (gazeY - pose.GazeY) * 0.4;

            double headX = lookX, headY = lookY, tiltExtra = 0;
            if (mood == Mood.Typing) { headX = lookX * 0.3; headY = 0.7; }
            if (pose.Shown == Expression.Sleepy) { headX = 0; headY = 1.2; tiltExtra = 5; }
            if (pose.Shown == Expression.Thinking) tiltExtra = -5;
            pose.HeadX += (headX * Face.HeadShiftX - pose.HeadX) * 0.25;
            pose.HeadY += (headY * Face.HeadShiftY - pose.HeadY) * 0.25;
            pose.HeadTilt += ((headX * Face.HeadTilt + tiltExtra) - pose.HeadTilt) * 0.25;

            // changing the face: the old one fades out, the new one fades in
            if (pose.Shown != wanted)
            {
                pose.Fade -= 0.35;
                if (pose.Fade <= 0)
                {
                    pose.Shown = wanted;
                    pose.Fade = 0;
                }
            }
            else if (pose.Fade < 1)
            {
                pose.Fade = Math.Min(1, pose.Fade + 0.35);
            }

            // blinking
            pose.Openness = 1;
            if (blinkStart < 0 && tick >= nextBlink) blinkStart = tick;
            if (blinkStart >= 0)
            {
                int i = (tick - blinkStart) / 2;
                if (i < BlinkOpenness.Length)
                {
                    pose.Openness = BlinkOpenness[i];
                }
                else
                {
                    blinkStart = -1;
                    nextBlink = tick + (rng.Next(5) == 0 ? 7 : 50 + rng.Next(81));
                }
            }
            pose.Spec = FaceSpec.Of(pose.Shown);
            pose.CursorOn = (tick / 8) % 2 == 0;
            pose.ZPhase = (tick % 60) / 60.0;
            return pose;
        }

        /// <summary>A reaction first, then the mood, then (when idle) a little personality.</summary>
        Expression Wanted()
        {
            if (reactions.Count > 0)
            {
                Expression current = reactions[0].Key;
                if (--reactionLeft <= 0)
                {
                    reactions.RemoveAt(0);
                    if (reactions.Count > 0) reactionLeft = reactions[0].Value;
                }
                return current;
            }
            switch (mood)
            {
                case Mood.Working:
                    if (tick >= nextThought)
                    {
                        thoughtUntil = tick + 36;
                        nextThought = thoughtUntil + 100 + rng.Next(121);
                    }
                    return tick < thoughtUntil ? Expression.Thinking : Expression.Terminal;
                case Mood.Happy: return Expression.Happy;
                case Mood.Error: return Expression.Error;
                case Mood.Stopped: return Expression.Sleepy;
                case Mood.Typing: return TypedLength > 90 ? Expression.Focus : Expression.Listening;
            }
            if (tick - lastActivity > 1000) return Expression.Sleepy;
            if (hasAmbient && tick < ambientUntil) return ambient;
            hasAmbient = false;
            if (tick >= nextAmbient)
            {
                ambient = Ambient[rng.Next(Ambient.Length)];
                hasAmbient = true;
                ambientUntil = tick + 20 + rng.Next(13);
                nextAmbient = ambientUntil + 160 + rng.Next(141);
                return ambient;
            }
            return Expression.Neutral;
        }
    }
}
