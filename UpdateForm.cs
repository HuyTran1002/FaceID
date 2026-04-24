using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.ComponentModel;
using System.Windows.Forms;
using System.Drawing.Drawing2D;

namespace FaceID
{
    public partial class UpdateForm : Form
    {
        private string downloadUrl;
        private WebClient webClient;
        private UpdateParams updateParams;
        private int retryCount = 0;
        private const int MAX_RETRIES = 5;
        
        // Colors
        private Color BackColorMain = Color.FromArgb(11, 14, 20);
        private Color AccentColor = Color.FromArgb(0, 210, 255);
        private Color TextColorMain = Color.FromArgb(240, 240, 240);
        private Color TextColorMuted = Color.FromArgb(150, 150, 150);

        public UpdateForm(string newVersion, string downloadUrl, UpdateParams p)
        {
            InitializeComponent();
            this.downloadUrl = downloadUrl;
            this.updateParams = p;
            this.Text = "FaceID Security - Cập nhật hệ thống";
            this.FormBorderStyle = FormBorderStyle.None; // Bỏ viền mặc định
            this.StartPosition = FormStartPosition.CenterScreen;
            this.Width = 550;
            this.Height = 320;
            this.BackColor = BackColorMain;

            SetupControls(newVersion);
            
            // Bo góc form (Windows API)
            try { Region = Region.FromHrgn(CreateRoundRectRgn(0, 0, Width, Height, 15, 15)); } catch { }
        }

        [System.Runtime.InteropServices.DllImport("Gdi32.dll", EntryPoint = "CreateRoundRectRgn")]
        private static extern IntPtr CreateRoundRectRgn(int nLeftRect, int nTopRect, int nRightRect, int nBottomRect, int nWidthEllipse, int nHeightEllipse);

        private void SetupControls(string newVersion)
        {
            // Panel Viền Neon
            Panel borderPanel = new Panel();
            borderPanel.Dock = DockStyle.Fill;
            borderPanel.Padding = new Padding(2);
            borderPanel.Paint += (s, e) => {
                e.Graphics.DrawRectangle(new Pen(AccentColor, 2), 0, 0, borderPanel.Width - 1, borderPanel.Height - 1);
            };
            this.Controls.Add(borderPanel);

            // Title Label
            Label titleLabel = new Label();
            titleLabel.Text = "CẬP NHẬT HỆ THỐNG";
            titleLabel.Font = new Font("Segoe UI", 16, FontStyle.Bold);
            titleLabel.ForeColor = AccentColor;
            titleLabel.Location = new Point(30, 30);
            titleLabel.AutoSize = true;
            borderPanel.Controls.Add(titleLabel);

            // Subtitle
            Label subTitle = new Label();
            subTitle.Text = "Phát hiện phiên bản mới: v" + newVersion;
            subTitle.Font = new Font("Segoe UI", 10);
            subTitle.ForeColor = TextColorMain;
            subTitle.Location = new Point(32, 65);
            subTitle.AutoSize = true;
            borderPanel.Controls.Add(subTitle);

            // Current Version
            Label currentVer = new Label();
            currentVer.Text = "Phiên bản hiện tại: v" + updateParams.CurrentVersion;
            currentVer.Font = new Font("Segoe UI", 9);
            currentVer.ForeColor = TextColorMuted;
            currentVer.Location = new Point(32, 88);
            currentVer.AutoSize = true;
            borderPanel.Controls.Add(currentVer);

            // Progress Bar (Custom)
            ProgressBar pb = new ProgressBar();
            pb.Name = "progressBar";
            pb.Location = new Point(30, 140);
            pb.Size = new Size(490, 12);
            pb.Style = ProgressBarStyle.Continuous;
            borderPanel.Controls.Add(pb);

            // Status Label
            Label statusLabel = new Label();
            statusLabel.Name = "statusLabel";
            statusLabel.Text = "Sẵn sàng để tối ưu hóa hệ thống...";
            statusLabel.Font = new Font("Segoe UI", 9);
            statusLabel.ForeColor = TextColorMuted;
            statusLabel.Location = new Point(30, 160);
            statusLabel.Size = new Size(490, 20);
            borderPanel.Controls.Add(statusLabel);

            // Download Button
            Button downloadBtn = new Button();
            downloadBtn.Name = "downloadBtn";
            downloadBtn.Text = "CẬP NHẬT NGAY";
            downloadBtn.Location = new Point(130, 230);
            downloadBtn.Size = new Size(140, 45);
            downloadBtn.FlatStyle = FlatStyle.Flat;
            downloadBtn.FlatAppearance.BorderSize = 0;
            downloadBtn.BackColor = AccentColor;
            downloadBtn.ForeColor = Color.Black;
            downloadBtn.Font = new Font("Segoe UI", 10, FontStyle.Bold);
            downloadBtn.Cursor = Cursors.Hand;
            downloadBtn.Click += DownloadBtn_Click;
            borderPanel.Controls.Add(downloadBtn);

            // Cancel Button
            Button cancelBtn = new Button();
            cancelBtn.Text = "ĐỂ SAU";
            cancelBtn.Location = new Point(290, 230);
            cancelBtn.Size = new Size(130, 45);
            cancelBtn.FlatStyle = FlatStyle.Flat;
            cancelBtn.FlatAppearance.BorderSize = 1;
            cancelBtn.FlatAppearance.BorderColor = Color.FromArgb(60, 60, 60);
            cancelBtn.BackColor = Color.Transparent;
            cancelBtn.ForeColor = TextColorMuted;
            cancelBtn.Font = new Font("Segoe UI", 10, FontStyle.Bold);
            cancelBtn.Cursor = Cursors.Hand;
            cancelBtn.Click += CancelBtn_Click;
            borderPanel.Controls.Add(cancelBtn);
            
            // Close X
            Label closeBtn = new Label();
            closeBtn.Text = "✕";
            closeBtn.Font = new Font("Arial", 12, FontStyle.Bold);
            closeBtn.ForeColor = Color.Gray;
            closeBtn.Location = new Point(515, 15);
            closeBtn.Size = new Size(20, 20);
            closeBtn.Cursor = Cursors.Hand;
            closeBtn.Click += (s, e) => this.Close();
            borderPanel.Controls.Add(closeBtn);
        }

        private void DownloadBtn_Click(object sender, EventArgs e)
        {
            Button downloadBtn = (Button)sender;
            downloadBtn.Enabled = false;
            downloadBtn.Text = "ĐANG TẢI...";
            downloadBtn.BackColor = Color.FromArgb(40, 40, 40);
            downloadBtn.ForeColor = Color.Gray;
            StartDownload();
        }

        private void StartDownload()
        {
            try
            {
                Label statusLabel = (Label)this.Controls.Find("statusLabel", true)[0];
                statusLabel.Text = "Đang kết nối tới máy chủ bảo mật...";

                string tempPath = Path.Combine(Path.GetTempPath(), "FaceIDUpdate");
                if (!Directory.Exists(tempPath)) Directory.CreateDirectory(tempPath);
                string newExePath = Path.Combine(tempPath, "FaceID_Security_NEW.exe");

                webClient = new WebClient();
                webClient.Headers.Add("User-Agent", "FaceID-Updater/5.0");
                ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;

                webClient.DownloadProgressChanged += (s, ev) =>
                {
                    ProgressBar pb = (ProgressBar)this.Controls.Find("progressBar", true)[0];
                    Label sl = (Label)this.Controls.Find("statusLabel", true)[0];
                    pb.Value = ev.ProgressPercentage;
                    sl.Text = string.Format("Tiến trình: {0}% - Đã tải {1:F1} MB / {2:F1} MB", 
                        ev.ProgressPercentage, ev.BytesReceived / 1048576.0, ev.TotalBytesToReceive / 1048576.0);
                };

                webClient.DownloadFileCompleted += (s, ev) =>
                {
                    if (ev.Error != null && retryCount < MAX_RETRIES)
                    {
                        retryCount++;
                        StartDownload();
                        return;
                    }
                    if (ev.Cancelled) return;
                    if (ev.Error != null)
                    {
                        MessageBox.Show("Lỗi kết nối: " + ev.Error.Message);
                        this.Controls.Find("downloadBtn", true)[0].Enabled = true;
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
            Label sl = (Label)this.Controls.Find("statusLabel", true)[0];
            sl.Text = "Đang khởi động tiến trình ghi đè bảo mật...";
            sl.ForeColor = AccentColor;

            try 
            {
                string flagFile = Path.Combine(updateParams.UserDataPath, "FaceID_Safe_Exit.flag");
                File.WriteAllText(flagFile, "SAFE_EXIT_FOR_UPDATE");
            } catch {}

            try
            {
                if (updateParams.ParentPid > 0)
                {
                    Process parent = Process.GetProcessById(updateParams.ParentPid);
                    parent.Kill();
                    parent.WaitForExit(3000);
                }
            } catch {}

            string originalExePath = updateParams.ExePath;
            string escapedNewPath = newExePath.Replace("'", "''");
            string escapedOriginalPath = originalExePath.Replace("'", "''");

            string psCommand = string.Format("Start-Sleep -s 1; $success = $false; for ($i=1; $i -le 20; $i++) {{ try {{ Copy-Item -Path '{0}' -Destination '{1}' -Force -ErrorAction Stop; $success = $true; break; }} catch {{ Start-Sleep -s 1; }} }}; if ($success) {{ Start-Process -FilePath '{1}'; }}; Remove-Item -Path '{0}';", 
                escapedNewPath, escapedOriginalPath);

            Process.Start(new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = string.Format("-NoProfile -WindowStyle Hidden -Command \"{0}\"", psCommand),
                UseShellExecute = true,
                Verb = "runas"
            });
            
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
}
