using System;
using System.Drawing;
using System.IO;
using System.Media;
using System.Windows.Forms;

static class CaptureWindow {
    static MemoryStream Tone(int frequency) {
        const int rate = 48000;
        var stream = new MemoryStream();
        var wav = new BinaryWriter(stream);
        wav.Write(new byte[] { 82, 73, 70, 70 });
        wav.Write(36 + rate * 2);
        wav.Write(new byte[] { 87, 65, 86, 69, 102, 109, 116, 32 });
        wav.Write(16);
        wav.Write((short)1);
        wav.Write((short)1);
        wav.Write(rate);
        wav.Write(rate * 2);
        wav.Write((short)2);
        wav.Write((short)16);
        wav.Write(new byte[] { 100, 97, 116, 97 });
        wav.Write(rate * 2);
        for (int i = 0; i < rate; i++) wav.Write((short)(2000 * Math.Sin(2 * Math.PI * frequency * i / rate)));
        stream.Position = 0;
        return stream;
    }

    [STAThread]
    static void Main(string[] args) {
        using (var form = new Form()) {
            form.Text = "Dorham owned capture fixture " + args[0];
            form.ClientSize = new Size(400, 220);
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(args[0] == "selected" ? 60 : 530, 90);
            form.ShowInTaskbar = false;
            form.BackColor = args[0] == "selected" ? Color.FromArgb(189, 24, 147) : Color.Lime;
            using (var samples = args.Length > 1 ? Tone(args[0] == "selected" ? 400 : 700) : null)
            using (var player = samples == null ? null : new SoundPlayer(samples))
            using (var timer = new Timer { Interval = 90 }) {
                if (player != null) player.PlayLooping();
                timer.Tick += (sender, evt) => {
                    if (args[0] == "selected") {
                        form.BackColor = form.BackColor.R == 189 ? Color.FromArgb(116, 24, 210) : Color.FromArgb(189, 24, 147);
                    }
                };
                form.Shown += (sender, evt) => {
                    Console.WriteLine(form.Handle.ToInt64());
                    timer.Start();
                };
                Application.Run(form);
            }
        }
    }
}
