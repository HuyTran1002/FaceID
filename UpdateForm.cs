using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.ComponentModel;
using System.Windows.Forms;

namespace FaceID
{
    public partial class UpdateForm : Form
    {
        private string downloadUrl;
        private WebClient webClient;
        private long totalBytes = 0;
        private long downloadedBytes = 0;
        private int retryCount = 0;
        private const int MAX_RETRIES = 5;

        public UpdateForm(string newVersion, string downloadUrl)
        {
            InitializeComponent();
            this.downloadUrl = downloadUrl;
            this.Text = "FaceID Security - Update";
            this.FormBorderStyle = FormBorderStyle.FixedDialog;
            this.MaximizeBox = false;
            this.MinimizeBox = false;
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Width = 520;
            this.Height = 300;

            SetupControls(newVersion);
            try { Theme.ApplyEcommerceTheme(this); } catch { }
        }

        private void SetupControls(string newVersion)
        {
            Label titleLabel = new Label();
            titleLabel.Text = "Phiên bản mới có sẵn!";
            titleLabel.Font = new Font("Segoe UI", 14, FontStyle.Bold);
            titleLabel.Location = new Point(20, 20);
            titleLabel.Size = new Size(440, 30);
            this.Controls.Add(titleLabel);

            Label versionLabel = new Label();
            versionLabel.Text = "Phiên bản mới: " + newVersion;
            versionLabel.Font = new Font("Segoe UI", 10);
            versionLabel.Location = new Point(20, 55);
            versionLabel.Size = new Size(440, 25);
            this.Controls.Add(versionLabel);

            ProgressBar progressBar = new ProgressBar();
            progressBar.Name = "progressBar";
            progressBar.Location = new Point(20, 120);
            progressBar.Size = new Size(440, 30);
            progressBar.Style = ProgressBarStyle.Continuous;
            this.Controls.Add(progressBar);

            Label statusLabel = new Label();
            statusLabel.Name = "statusLabel";
            statusLabel.Text = "Sẵn sàng để tải...";
            statusLabel.Font = new Font("Segoe UI", 9);
            statusLabel.Location = new Point(20, 155);
            statusLabel.Size = new Size(440, 20);
            statusLabel.ForeColor = Color.Gray;
            this.Controls.Add(statusLabel);

            Button downloadBtn = new Button();
            downloadBtn.Name = "downloadBtn";
            downloadBtn.Text = "Update";
            downloadBtn.Location = new Point(140, 200);
            downloadBtn.Size = new Size(120, 35);
            downloadBtn.BackColor = Color.FromArgb(0, 191, 165);
            downloadBtn.ForeColor = Color.White;
            downloadBtn.Font = new Font("Segoe UI", 10, FontStyle.Bold);
            downloadBtn.Click += DownloadBtn_Click;
            this.Controls.Add(downloadBtn);

            Button cancelBtn = new Button();
            cancelBtn.Text = "Hủy";
            cancelBtn.Location = new Point(280, 200);
            cancelBtn.Size = new Size(120, 35);
            cancelBtn.Font = new Font("Segoe UI", 10);
            cancelBtn.Click += CancelBtn_Click;
            this.Controls.Add(cancelBtn);
        }

        private void DownloadBtn_Click(object sender, EventArgs e)
        {
            Button downloadBtn = (Button)sender;
            downloadBtn.Enabled = false;

            StartDownload();
        }

        private void StartDownload()
        {
            try
            {
                Label statusLabel = (Label)this.Controls["statusLabel"];
                statusLabel.Text = "Đang kết nối...";

                string tempPath = Path.Combine(Path.GetTempPath(), "FaceIDUpdate");
                if (!Directory.Exists(tempPath)) Directory.CreateDirectory(tempPath);

                string newExePath = Path.Combine(tempPath, "FaceID_Security_NEW.exe");

                webClient = new WebClient();
                webClient.Headers.Add("User-Agent", "FaceID-Updater/5.0");
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2

                webClient.DownloadProgressChanged += (s, ev) =>
                {
                    ProgressBar pb = (ProgressBar)this.Controls["progressBar"];
                    Label sl = (Label)this.Controls["statusLabel"];
                    pb.Value = ev.ProgressPercentage;
                    sl.Text = string.Format("Đang tải: {0}% ({1:F2}MB / {2:F2}MB)", 
                        ev.ProgressPercentage, ev.BytesReceived / 1048576.0, ev.TotalBytesToReceive / 1048576.0);
                };

                webClient.DownloadFileCompleted += (s, ev) =>
                {
                    if (ev.Error != null && retryCount < MAX_RETRIES)
                    {
                        retryCount++;
                        Label sl = (Label)this.Controls["statusLabel"];
                        sl.Text = string.Format("Lỗi kết nối. Thử lại lần {0}...", retryCount);
                        StartDownload();
                        return;
                    }

                    if (ev.Cancelled) return;
                    if (ev.Error != null)
                    {
                        MessageBox.Show("Lỗi: " + ev.Error.Message);
                        this.Controls["downloadBtn"].Enabled = true;
                        return;
                    }

                    InstallUpdate(newExePath);
                };

                webClient.DownloadFileAsync(new Uri(downloadUrl), newExePath);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Lỗi: " + ex.Message);
            }
        }

        private void InstallUpdate(string newExePath)
        {
            string originalExePath = Process.GetCurrentProcess().MainModule.FileName;
            string escapedNewPath = newExePath.Replace("'", "''");
            string escapedOriginalPath = originalExePath.Replace("'", "''");

            string psCommand = string.Format("Start-Sleep -s 2; $success = $false; for ($i=1; $i -le 15; $i++) {{ try {{ Copy-Item -Path '{0}' -Destination '{1}' -Force -ErrorAction Stop; $success = $true; break; }} catch {{ Start-Sleep -s 1; }} }}; if ($success) {{ Start-Process -FilePath '{1}'; }}; Remove-Item -Path '{0}';", 
                escapedNewPath, escapedOriginalPath);

            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = string.Format("-NoProfile -WindowStyle Hidden -Command \"{0}\"", psCommand),
                UseShellExecute = true,
                Verb = "runas"
            });
            
            // Tạo cờ hiệu thoát an toàn để Watchdog không hồi sinh app (v5.0.2)
            try 
            {
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
                string faceIdDir = Path.Combine(appData, "faceid");
                if (!Directory.Exists(faceIdDir)) Directory.CreateDirectory(faceIdDir);
                File.WriteAllText(Path.Combine(faceIdDir, "FaceID_Safe_Exit.flag"), "SAFE_EXIT_FOR_UPDATE");
            } catch {}

            Application.Exit();
            Environment.Exit(0);
        }

        private void CancelBtn_Click(object sender, EventArgs e)
        {
            if (webClient != null) webClient.CancelAsync();
            this.Close();
        }

        private void InitializeComponent()
        {
            this.AutoScaleDimensions = new SizeF(7F, 15F);
            this.AutoScaleMode = AutoScaleMode.Font;
            this.ClientSize = new Size(500, 250);
            this.Name = "UpdateForm";
            this.Font = new Font("Segoe UI", 9F);
        }
    }

    public static class Theme
    {
        public static void ApplyEcommerceTheme(Form form)
        {
            form.BackColor = Color.FromArgb(18, 18, 18);
            foreach (Control ctrl in form.Controls)
            {
                if (ctrl is Label) ctrl.ForeColor = Color.FromArgb(230, 230, 230);
                if (ctrl is Button)
                {
                    Button btn = (Button)ctrl;
                    btn.BackColor = btn.Name == "downloadBtn" ? Color.FromArgb(0, 191, 165) : Color.FromArgb(45, 45, 45);
                    btn.ForeColor = Color.White;
                    btn.FlatStyle = FlatStyle.Flat;
                    btn.FlatAppearance.BorderSize = 0;
                }
                if (ctrl is ProgressBar)
                {
                    ctrl.BackColor = Color.FromArgb(45, 45, 45);
                    ctrl.ForeColor = Color.FromArgb(0, 191, 165);
                }
            }
        }
    }
}
