using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace Dorham.Monitor;

public sealed class MetricCard : Border
{
    private readonly TextBlock value = new() { Text = "—", FontSize = 30, FontWeight = FontWeights.SemiBold, Margin = new(0, 8, 0, 6) };
    private readonly TextBlock detail = new() { Text = "Waiting for a reading", FontSize = 11, Foreground = Palette.Muted };
    private readonly ProgressBar bar = new() { Maximum = 100, Margin = new(0, 10, 0, 0), Height = 5 };
    public MetricCard()
    {
        Background = Palette.Surface; BorderBrush = Palette.Border; BorderThickness = new(1); CornerRadius = new(14); Padding = new(18); Margin = new(0, 0, 12, 0);
        var panel = new StackPanel();
        panel.Children.Add(title); panel.Children.Add(value); panel.Children.Add(detail); panel.Children.Add(bar); Child = panel;
    }
    private readonly TextBlock title = new() { Foreground = Palette.Muted, FontSize = 12, FontWeight = FontWeights.SemiBold };
    public string Heading { get => title.Text; set => title.Text = value; }
    public string CurrentText => value.Text;
    public Brush Tint { get => bar.Foreground; set => bar.Foreground = value; }
    public void Update(string text, string description, double? percent)
    {
        value.Text = text; detail.Text = description; bar.Value = percent ?? 0;
        value.Foreground = percent >= 90 ? Palette.Amber : Palette.Text;
        ToolTip = description;
    }
}

public static class Palette
{
    public static readonly Brush Surface = Brush("#191D27"), Border = Brush("#2B303F"), Muted = Brush("#929BAD"), Text = Brush("#F2F4FA"), Green = Brush("#85E6BE"), Purple = Brush("#B6A0FF"), Blue = Brush("#83BDF9"), Amber = Brush("#F1BF77"), Red = Brush("#F28C98");
    public static SolidColorBrush Brush(string hex) { var b = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex)); b.Freeze(); return b; }
}

public sealed class HistoryChart : FrameworkElement
{
    public List<(double? A, double? B)> Values { get; } = [];
    public Brush First { get; set; } = Palette.Green;
    public Brush Second { get; set; } = Palette.Purple;
    public bool Percentage { get; set; } = true;
    protected override void OnRender(DrawingContext dc)
    {
        base.OnRender(dc);
        double w = Math.Max(1, ActualWidth - 45), h = Math.Max(1, ActualHeight - 12);
        double max = Percentage ? 100 : Math.Max(1024, Values.SelectMany(v => new[] { v.A ?? 0, v.B ?? 0 }).DefaultIfEmpty().Max() * 1.18);
        for (int i = 0; i <= 4; i++)
        {
            double y = i * h / 4;
            dc.DrawLine(new Pen(Palette.Border, 0.6), new(0, y), new(w, y));
            string label = Percentage ? ((int)(max * (4 - i) / 4)).ToString(CultureInfo.InvariantCulture) + "%" : Format.Rate(max * (4 - i) / 4);
            var text = new FormattedText(label, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, new Typeface("Segoe UI"), 10, Palette.Muted, VisualTreeHelper.GetDpi(this).PixelsPerDip);
            dc.DrawText(text, new(w + 8, Math.Max(0, y - 7)));
        }
        DrawSeries(dc, Values.Select(v => v.A).ToArray(), w, h, max, First, true);
        DrawSeries(dc, Values.Select(v => v.B).ToArray(), w, h, max, Second, false);
    }
    private static void DrawSeries(DrawingContext dc, double?[] values, double w, double h, double max, Brush color, bool fill)
    {
        if (values.Length < 2) return;
        int start = 0;
        while (start < values.Length)
        {
            while (start < values.Length && values[start] == null) start++;
            int end = start;
            while (end < values.Length && values[end] != null) end++;
            if (end - start >= 2)
            {
                Point PointAt(int i) => new(i * w / (values.Length - 1), h * (1 - Math.Clamp(values[i]!.Value / max, 0, 1)));
                var line = new StreamGeometry();
                using (var c = line.Open()) { c.BeginFigure(PointAt(start), false, false); for (int i = start + 1; i < end; i++) c.LineTo(PointAt(i), true, false); }
                if (fill)
                {
                    var area = new StreamGeometry();
                    using (var c = area.Open()) { c.BeginFigure(new(PointAt(start).X, h), true, true); for (int i = start; i < end; i++) c.LineTo(PointAt(i), true, false); c.LineTo(new(PointAt(end - 1).X, h), true, false); }
                    var shade = ((SolidColorBrush)color).Color;
                    dc.DrawGeometry(new LinearGradientBrush(Color.FromArgb(38, shade.R, shade.G, shade.B), Color.FromArgb(0, shade.R, shade.G, shade.B), 90), null, area);
                }
                dc.DrawGeometry(null, new Pen(color, 2) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round, LineJoin = PenLineJoin.Round }, line);
            }
            start = end + 1;
        }
    }
}

public static class Format
{
    public static string Bytes(double bytes)
    {
        string[] units = ["B", "KiB", "MiB", "GiB", "TiB"];
        int index = 0;
        while (bytes >= 1024 && index < units.Length - 1) { bytes /= 1024; index++; }
        return bytes.ToString(index < 2 ? "0" : "0.0", CultureInfo.InvariantCulture) + " " + units[index];
    }
    public static string Rate(double? bytes) => bytes == null ? "—" : Bytes(bytes.Value) + "/s";
    public static string Uptime(double seconds) { var t = TimeSpan.FromSeconds(seconds); return t.Days > 0 ? $"{t.Days}d {t.Hours}h {t.Minutes}m" : $"{t.Hours}h {t.Minutes}m"; }
}
