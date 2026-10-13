// Tests for HudLogic.cs. Run with `node packages/daemon/scripts/check-windows-hud.mjs` (needs the .NET SDK).
using System;
using System.Collections.Generic;
using RemoteHands;

static class Tests
{
    static int failures;
    static int count;

    static void Eq(object expected, object actual, string what)
    {
        count++;
        if (!object.Equals(expected, actual))
        {
            failures++;
            Console.WriteLine("FAIL " + what + ": expected [" + expected + "] got [" + actual + "]");
        }
    }

    static void True(bool value, string what) { Eq(true, value, what); }

    static int Main()
    {
        JsonTests();
        ArgsTests();
        MessageTests();
        StateTests();
        LinkTests();
        NameTests();
        Console.WriteLine(count + " checks, " + failures + " failed");
        return failures == 0 ? 0 : 1;
    }

    static void JsonTests()
    {
        var obj = Json.Parse("{\"status\":\"WORKING\",\"text\":\"a \\\"quoted\\\" line\\nnext \\u00e9 \\ud83d\\ude00\",\"n\":12.5,\"ok\":true,\"none\":null,\"list\":[1,\"two\",{\"k\":\"v\"}]}") as Dictionary<string, object>;
        True(obj != null, "object parses");
        Eq("WORKING", Json.GetString(obj, "status"), "string field");
        Eq("a \"quoted\" line\nnext \u00e9 \ud83d\ude00", Json.GetString(obj, "text"), "escapes and surrogate pairs");
        Eq(12.5, obj["n"], "number");
        Eq(true, obj["ok"], "true");
        True(obj["none"] == null, "null");
        Eq(3, ((List<object>)obj["list"]).Count, "array length");
        Eq("v", Json.GetString(((List<object>)obj["list"])[2], "k"), "object in array");
        Eq(null, Json.GetString(obj, "missing"), "missing key");
        Eq(null, Json.GetString(obj, "n"), "non-string field is not a string");
        foreach (string bad in new string[] { "", "{", "{\"a\":}", "[1,]", "{\"a\":1} x", "nul", "\"abc", "{\"a\" 1}", "\"\\x\"", "\"\\u12\"", "tru" })
            True(Json.Parse(bad) == null, "invalid json rejected: " + bad);
        Eq("{ }".Length, 3, "sanity");
        True(Json.Parse("  { }  ") is Dictionary<string, object>, "spaces around empty object");
        string deep = new string('[', 100) + new string(']', 100);
        True(Json.Parse(deep) == null, "absurdly deep json rejected, not a crash");
        Eq("\"a\\\"b\\\\c\\nd\\te\\u0001\"", Json.Quote("a\"b\\c\nd\te\u0001"), "quote escapes");
        Eq("\"\\u2028\"", Json.Quote("\u2028"), "line separator is escaped");
        Eq("null", Json.Quote(null), "null quote");
        // a quoted string reads back to itself
        string tricky = "x\"y\\z\r\n\t\u0007 \u00fc \ud83d\ude00 end";
        Eq(tricky, Json.Parse(Json.Quote(tricky)), "quote round trip");
    }

    static void ArgsTests()
    {
        var a = HudArgs.Parse(new string[] { "prompt", "--app=Google Chrome", "--window-title=Inbox - \"Mail\"", "--models=[{\"key\":\"a\",\"label\":\"Model A\"},{\"key\":\"b\",\"label\":\"Model B\"},{\"key\":\"\",\"label\":\"x\"},{\"label\":\"y\"},5]", "--model=b" });
        Eq("prompt", a.Mode, "prompt mode");
        Eq("Google Chrome", a.App, "app");
        Eq("Inbox - \"Mail\"", a.WindowTitle, "window title with quotes");
        Eq(2, a.Models.Count, "models without a key or label are skipped");
        Eq("Model B", a.Models[1].Label, "model label");
        Eq("b", a.ModelKey, "chosen model");
        Eq("listen", HudArgs.Parse(new string[] { "listen" }).Mode, "listen mode");
        var s = HudArgs.Parse(new string[] { "supervise", "--node=C:\\Program Files\\nodejs\\node.exe", "--cli=C:\\Users\\Ana Lee\\.remote-hands\\cli\\index.js" });
        Eq("supervise", s.Mode, "supervise mode");
        Eq("C:\\Program Files\\nodejs\\node.exe", s.NodePath, "node path with spaces");
        Eq("C:\\Users\\Ana Lee\\.remote-hands\\cli\\index.js", s.CliPath, "cli path with spaces");
        var empty = HudArgs.Parse(new string[] { "--app=" });
        Eq("Desktop", empty.App, "empty app becomes Desktop");
        Eq(0, HudArgs.Parse(new string[] { "--models=not json" }).Models.Count, "bad models json is ignored");
        Eq("prompt", HudArgs.Parse(null).Mode, "no args");
    }

    static void MessageTests()
    {
        string line = Messages.Submit("open \"mail\"\nplease", "Google Chrome", "Inbox", "claude-opus");
        var parsed = Json.Parse(line) as Dictionary<string, object>;
        Eq("submit", Json.GetString(parsed, "event"), "submit event");
        Eq("open \"mail\"\nplease", Json.GetString(parsed, "query"), "query survives");
        Eq("Google Chrome", Json.GetString(parsed, "app"), "app");
        Eq("Inbox", Json.GetString(parsed, "windowTitle"), "window title");
        Eq("claude-opus", Json.GetString(parsed, "model"), "model");
        True(line.IndexOf('\n') < 0, "one line");
        var bare = Json.Parse(Messages.Submit("hi", "Desktop", "", "")) as Dictionary<string, object>;
        True(!bare.ContainsKey("windowTitle") && !bare.ContainsKey("model"), "empty optional fields are left out");
        Eq("{\"event\":\"stop\"}", Messages.Stop(), "stop");
        Eq("{\"event\":\"cancel\"}", Messages.Cancel(), "cancel");
        Eq("{\"event\":\"model\",\"model\":\"gpt-oss\"}", Messages.Model("gpt-oss"), "model event");
        var hot = Json.Parse(Messages.Hotkey("Microsoft Edge", "Doc \"1\"")) as Dictionary<string, object>;
        Eq("hotkey", Json.GetString(hot, "event"), "hotkey event");
        Eq("Doc \"1\"", Json.GetString(hot, "windowTitle"), "hotkey title");
        Eq("{\"event\":\"hotkey-ready\",\"keys\":\"Ctrl+Shift+Space\"}", Messages.HotkeyReady("Ctrl+Shift+Space"), "hotkey ready");
    }

    static void StateTests()
    {
        var st = new HudState();
        st.Submitted();
        True(st.IsWorking && st.IsExpanded && st.StopVisible && !st.CopyVisible, "submitting starts work");
        Eq("Starting", st.StatusWord, "starting word");

        var r = st.Apply("READING", "Opened the page", "");
        Eq("Reading", st.StatusWord, "status word is capitalised");
        Eq(1, r.Entries.Count, "a step is added");
        Eq(EntryKind.Step, r.Entries[0].Kind, "step kind");
        r = st.Apply("WORKING", "Needs your attention", "ATTENTION");
        Eq(EntryKind.Attention, r.Entries[0].Kind, "attention kind");
        r = st.Apply("WORKING", "", "");
        Eq(0, r.Entries.Count, "a word-only update adds nothing while working");
        True(st.IsWorking, "still working");

        r = st.Apply("COMPLETE", "  All done.  ", "");
        True(!st.IsWorking && !st.StopVisible && st.CopyVisible, "done: not working, copy offered");
        Eq(EntryKind.Answer, r.Entries[0].Kind, "answer entry");
        Eq("All done.", r.Entries[0].Text, "answer trimmed");
        Eq("All done.", st.AnswerText, "answer kept for Copy");
        True(r.GiveInputBack, "input is given back");
        Eq("Done", st.StatusWord, "done word");

        r = st.Apply("THINKING", "", "");
        True(r.Ignored && !st.IsWorking, "a late status word does not bring the spinner back");
        r = st.Apply("WORKING", "Another step", "");
        True(st.IsWorking && !st.CopyVisible, "a real step starts work again and hides Copy");

        r = st.Apply("FAILED", "", "");
        Eq("The task failed.", r.Entries[0].Text, "default failure text");
        Eq(EntryKind.Error, r.Entries[0].Kind, "failure is an error entry");
        True(!st.IsWorking && r.GiveInputBack && st.StatusTone == Tone.Danger, "failure ends the task");

        var st2 = new HudState();
        st2.Submitted();
        r = st2.Apply("COMPLETE", "", "");
        Eq("Task completed successfully.", r.Entries[0].Text, "default done text");
        r = st2.Apply("ERROR", "Something small", "");
        Eq(EntryKind.Error, r.Entries[0].Kind, "error entry");
        True(!r.GiveInputBack, "an error line alone does not end the task");

        var st3 = new HudState();
        st3.Submitted();
        FeedEntry stopped = st3.StopClicked();
        Eq("Stopped.", stopped.Text, "stop note");
        True(!st3.IsWorking && !st3.StopVisible, "stop ends work");
        r = st3.Apply("STOPPED", "ignored text", "");
        Eq(0, r.Entries.Count, "a stop that arrives after the person stopped adds no second note");
        var st4 = new HudState();
        st4.Submitted();
        r = st4.Apply("CANCELLED", "", "");
        Eq("Stopped.", r.Entries[0].Text, "daemon-side stop while working");
        True(r.GiveInputBack, "input is back after a stop");
        r = new HudState().Apply(null, null, null);
        True(r.Ignored, "an empty message while idle is ignored, and does not crash");
        Eq("Reading", HudState.DisplayStatus("READING"), "display status");
        Eq("", HudState.DisplayStatus(null), "display status of nothing");
    }

    static void LinkTests()
    {
        True(Links.IsOpenable("https://example.com/a?b=c"), "https");
        True(Links.IsOpenable("HTTP://example.com"), "http upper case");
        True(Links.IsOpenable("mailto:a@b.com"), "mailto");
        foreach (string bad in new string[] { "file:///C:/Windows/System32/calc.exe", "C:\\Windows\\System32\\cmd.exe", "javascript:alert(1)", "ms-msdt:/id", "\\\\server\\share", "", null, "example.com", "ftp://x" })
            True(!Links.IsOpenable(bad), "not openable: " + bad);
    }

    static void NameTests()
    {
        Eq("Google Chrome", AppNames.Friendly("chrome"), "chrome");
        Eq("Microsoft Edge", AppNames.Friendly("msedge"), "edge");
        Eq("Microsoft Edge", AppNames.Friendly("MSEDGE.EXE"), "edge with extension and case");
        Eq("Desktop", AppNames.Friendly(""), "nothing");
        Eq("Desktop", AppNames.Friendly("SearchHost"), "shell host");
        Eq("Spotify", AppNames.Friendly("spotify"), "unknown program is capitalised");
    }
}
