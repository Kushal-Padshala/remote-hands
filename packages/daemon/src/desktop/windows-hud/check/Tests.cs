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
        MascotTests();
        CardTests();
        Console.WriteLine(count + " checks, " + failures + " failed");
        return failures == 0 ? 0 : 1;
    }

    static void CardTests()
    {
        var stack = new CardStack();
        Card goal = stack.Add(new FeedEntry(EntryKind.Goal, "open notes"), 0, true);
        True(goal.Latest && goal.Working, "request card is live");
        Card a = stack.Add(new FeedEntry(EntryKind.Step, "Opening Notes"), 10, true);
        True(a.InProgress, "a new step is in progress");
        Card b = stack.Add(new FeedEntry(EntryKind.Step, "Typing"), 20, true);
        True(!a.InProgress && b.InProgress, "the next step finishes the last one");
        stack.SetWorking(false, 100, 10);
        True(!b.InProgress, "the end of the task finishes the step");
        Eq(10, goal.FinishedSeconds, "request remembers how long it took");
        Card answer = stack.Add(new FeedEntry(EntryKind.Answer, "All done"), 101, false);
        Eq("Done", answer.Title, "answer title");
        Eq("All done", answer.Body, "answer body");
        True(object.ReferenceEquals(stack.Answer, answer), "answer is remembered");
        Card second = stack.Add(new FeedEntry(EntryKind.Goal, "again"), 110, true);
        True(!goal.Latest && !goal.Working && second.Latest, "the older request gives up its buttons");

        foreach (Card c in stack.Cards) c.Height = 40;
        Eq(5 * 40 + 4 * CardStack.Gap + CardStack.Tail, stack.Layout(), "stack height");
        Eq(0, stack.Cards[0].Y, "first card at the top");
        Eq(40 + CardStack.Gap, stack.Cards[1].Y, "second card below the first");
        stack.Clear();
        Eq(0, stack.Layout(), "empty stack has no height");

        True(CardStack.IsDimmed(0, 6, false), "older card dims");
        True(!CardStack.IsDimmed(0, 6, true), "hover undims");
        True(!CardStack.IsDimmed(3, 6, false), "newest three stay clear");
        Eq(600, CardStack.MaxHeight(900), "max height cap");
        Eq(200, CardStack.MaxHeight(50), "max height floor");
        Eq(0, CardStack.ClampScroll(-5, 500, 300), "scroll clamps at the top");
        Eq(200, CardStack.ClampScroll(900, 500, 300), "scroll clamps at the end");
        Eq(0, CardStack.ClampScroll(30, 100, 300), "short stack does not scroll");
        Eq(1.0, CardStack.TopFade(0), "no fade at the top edge");
        Eq(0.0, CardStack.TopFade(24), "top fades once scrolled");
        Eq(1.0, CardStack.BottomFade(200, 500, 300), "no fade when the end is in view");
        Eq(0.0, CardStack.BottomFade(0, 500, 300), "bottom fades while more waits");
        Eq("Working...", CardStack.StatusLine("Working", true, 3, 1), "dots, no time yet");
        Eq("Working.  \u00B7  12s", CardStack.StatusLine("Working", true, 1, 12), "time shows after three seconds");
        Eq("Done  \u00B7  14s", CardStack.StatusLine("Done", false, 2, 14), "no dots when done");
    }

    static void MascotTests()
    {
        // idle: looks at the cursor with eyes and head, and blinks
        var idle = new MascotBrain(7);
        MascotPose p = null;
        for (int i = 0; i < 40; i++) p = idle.Step(1, 0, true);
        True(p.GazeX > 0.95 && p.HeadX > Face.HeadShiftX * 0.9 && p.HeadTilt > Face.HeadTilt * 0.9, "eyes, head and tilt follow a cursor on the right");
        for (int i = 0; i < 40; i++) p = idle.Step(-1, 1, true);
        True(p.GazeX < -0.95 && p.GazeY > 0.95 && p.HeadX < -Face.HeadShiftX * 0.9 && p.HeadY > Face.HeadShiftY * 0.9 && p.HeadTilt < -Face.HeadTilt * 0.9, "and one down on the left");
        bool shut = false;
        bool reopened = false;
        for (int i = 0; i < 400; i++)
        {
            p = idle.Step(0, 0, true);
            if (p.Openness < 0.1) shut = true;
            else if (shut && p.Openness == 1) reopened = true;
        }
        True(shut && reopened, "it blinks and opens its eyes again");

        // typing: looks down at the text, wherever the cursor is; a long request makes it concentrate
        var typing = new MascotBrain(1);
        typing.SetMood(Mood.Typing);
        for (int i = 0; i < 40; i++) p = typing.Step(-1, -1, true);
        True(p.GazeY > 0.85 && Math.Abs(p.GazeX + 0.7) < 0.05, "looks down at the start of the text while typing");
        Eq(Expression.Listening, p.Shown, "an ordinary request: listening");
        typing.TypedLength = 30;
        for (int i = 0; i < 40; i++) p = typing.Step(-1, -1, true);
        True(Math.Abs(p.GazeX - 0.2) < 0.05, "and reads along as the text grows");
        typing.TypedLength = 200;
        for (int i = 0; i < 10; i++) p = typing.Step(0, 0, true);
        Eq(Expression.Focus, p.Shown, "a long request: focus");

        // working: a terminal prompt in the eyes, now and then a thoughtful look
        var work = new MascotBrain(3);
        work.SetMood(Mood.Working);
        var seen = new HashSet<Expression>();
        for (int i = 0; i < 600; i++) seen.Add(work.Step(0, 0, true).Shown);
        True(seen.Contains(Expression.Terminal) && seen.Contains(Expression.Thinking) && !seen.Contains(Expression.Happy) && !seen.Contains(Expression.Error), "working shows the terminal prompt and thinks now and then");

        // the end of a task
        var done = new MascotBrain(1);
        done.SetMood(Mood.Happy);
        for (int i = 0; i < 6; i++) p = done.Step(0, 0, true);
        Eq(Expression.Happy, p.Shown, "a finished task smiles");
        True(done.HopOffset() >= 0, "hop offset is readable");
        for (int i = 0; i < 20; i++) done.Step(0, 0, true);
        Eq(0, done.HopOffset(), "the hop ends");
        for (int i = 0; i < 100; i++) p = done.Step(0, 0, true);
        Eq(Mood.Idle, done.Current, "the smile fades back to idle");
        var bad = new MascotBrain(1);
        bad.SetMood(Mood.Error);
        for (int i = 0; i < 6; i++) p = bad.Step(0, 0, true);
        True(p.Shown == Expression.Error && p.Spec.Warning, "a failed task looks upset, in red");
        var stopped = new MascotBrain(1);
        stopped.SetMood(Mood.Stopped);
        for (int i = 0; i < 6; i++) p = stopped.Step(0, 0, true);
        True(p.Shown == Expression.Sleepy && p.Spec.Zzz, "a stopped task dozes");

        // click: surprise, then laughter
        var poke = new MascotBrain(1);
        poke.Poke();
        var kinds = new HashSet<Expression>();
        for (int i = 0; i < 60; i++) kinds.Add(poke.Step(0, 0, true).Shown);
        True(kinds.Contains(Expression.Surprised) && kinds.Contains(Expression.Laugh), "a poke surprises it, then makes it laugh");

        // left alone for a long time it falls asleep, and wakes when the cursor moves
        var lonely = new MascotBrain(5);
        for (int i = 0; i < 1100; i++) p = lonely.Step(0, 0, false);
        Eq(Expression.Sleepy, p.Shown, "it dozes off after about a minute alone");
        for (int i = 0; i < 12; i++) p = lonely.Step(0, 0, true);
        True(p.Shown != Expression.Sleepy, "and wakes when the cursor moves");

        // idle faces: over a few minutes it makes some of its small faces
        var ambient = new MascotBrain(9);
        var faces = new HashSet<Expression>();
        for (int i = 0; i < 4000; i++) faces.Add(ambient.Step(0, 0, true).Shown);
        True(faces.Contains(Expression.Neutral) && faces.Count >= 3, "idle: now and then a small face");

        Eq(Mood.Working, MascotBrain.MoodFor(true, Tone.Success), "working beats the tone");
        Eq(Mood.Happy, MascotBrain.MoodFor(false, Tone.Success), "done");
        Eq(Mood.Error, MascotBrain.MoodFor(false, Tone.Danger), "failed");
        Eq(Mood.Stopped, MascotBrain.MoodFor(false, Tone.Warning), "stopped");
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
        True(HudArgs.Parse(new string[] { "prompt", "--once" }).Once, "one-shot prompt");
        True(!HudArgs.Parse(new string[] { "prompt" }).Once, "not one-shot by default");
        var cfg = SupervisorSettings.Parse("{\"node\":\"C:\\\\Program Files\\\\nodejs\\\\node.exe\",\"cli\":\"C:\\\\Users\\\\Ana Lee\\\\.remote-hands\\\\cli\\\\index.js\"}");
        Eq("C:\\Program Files\\nodejs\\node.exe", cfg.Node, "settings: node path");
        Eq("C:\\Users\\Ana Lee\\.remote-hands\\cli\\index.js", cfg.Cli, "settings: cli path");
        Eq("", SupervisorSettings.Parse("not json").Node, "bad settings are empty");
        Eq("", SupervisorSettings.Parse("{\"node\":5}").Node, "non-string node is ignored");
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
