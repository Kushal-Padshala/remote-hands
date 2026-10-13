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

        public static HudArgs Parse(string[] args)
        {
            var result = new HudArgs();
            if (args == null) return result;
            foreach (string arg in args)
            {
                if (arg == null) continue;
                if (arg == "listen") result.Mode = "listen";
                else if (arg == "supervise") result.Mode = "supervise";
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
}
