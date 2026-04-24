using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace FaceID
{
    public partial class UpdateForm : Form
    {
        private string downloadUrl;
        private HttpClient httpClient;
        private CancellationTokenSource cancellationTokenSource;
        private long totalBytes = 0;
        private long downloadedBytes = 0;
        private const int BUFFER_SIZE = 65536;
        private const int MAX_RETRIES = 5;
        private DateTime lastUpdateTime = DateTime.Now;
        private long lastDownloadedBytes = 0;

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

            var handler = new HttpClientHandler
            {
                AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
                AllowAutoRedirect = true,
                MaxConnectionsPerServer = 10,
                UseCookies = false
            };
            
            httpClient = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromMinutes(30)
            };
            
            httpClient.DefaultRequestHeaders.Add("User-Agent", "FaceID-Updater/5.0");
            httpClient.DefaultRequestHeaders.ConnectionClose = false;
            
            cancellationTokenSource = new CancellationTokenSource();

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

            Label currentVersionLabel = new Label();
            var assembly = System.Reflection.Assembly.GetExecutingAssembly();
            var version = assembly.GetName().Version;
            currentVersionLabel.Text = string.Format("Phiên bản hiện tại: {0}.{1}.{2}.{3}", 
                version.Major, version.Minor, version.Build, version.Revision);
            currentVersionLabel.Font = new Font("Segoe UI", 10);
            currentVersionLabel.Location = new Point(20, 80);
            currentVersionLabel.Size = new Size(440, 25);
            this.Controls.Add(currentVersionLabel);

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
            downloadBtn.BackColor = Color.FromArgb(0, 120, 215);
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

        private async void DownloadBtn_Click(object sender, EventArgs e)
        {
            Button downloadBtn = (Button)sender;
            downloadBtn.Enabled = false;

            try
            {
                Label statusLabel = (Label)this.Controls["statusLabel"];
                statusLabel.Text = "Đang tải phiên bản mới...";
                this.Refresh();

                string tempPath = Path.Combine(Path.GetTempPath(), "FaceIDUpdate");
                if (!Directory.Exists(tempPath))
                    Directory.CreateDirectory(tempPath);

                string newExePath = Path.Combine(tempPath, "FaceID_Security_NEW.exe");
                await DownloadFileAsync(downloadUrl, newExePath);

                if (File.Exists(newExePath))
                {
                    statusLabel.Text = "Tải xong! Đang cập nhật ẩn...";
                    this.Refresh();
                    await Task.Delay(500);

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
                    
                    Application.Exit();
                    Environment.Exit(0);
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("Lỗi: " + ex.Message, "Lỗi", MessageBoxButtons.OK, MessageBoxIcon.Error);
                downloadBtn.Enabled = true;
            }
        }

        private async Task DownloadFileAsync(string url, string filePath)
        {
            int retryCount = 0;
            Exception lastException = null;

            while (retryCount < MAX_RETRIES)
            {
                try
                {
                    await DownloadFileWithProgressAsync(url, filePath);
                    return;
                }
                catch (Exception ex)
                {
                    lastException = ex;
                    retryCount++;
                    
                    this.Invoke((MethodInvoker)(() =>
                    {
                        Label statusLabel = (Label)this.Controls["statusLabel"];
                        statusLabel.Text = string.Format("Kết nối bị gián đoạn. Đang thử lại ({0}/{1})...", retryCount, MAX_RETRIES);
                    }));
                    
                    await Task.Delay(1000 * retryCount);
                }
            }
            throw lastException ?? new Exception("Download failed");
        }

        private async Task DownloadFileWithProgressAsync(string url, string filePath)
        {
            using (var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationTokenSource.Token))
            {
                response.EnsureSuccessStatusCode();
                totalBytes = response.Content.Headers.ContentLength ?? -1L;

                using (var contentStream = await response.Content.ReadAsStreamAsync())
                using (var fileStream = new FileStream(filePath, FileMode.Create, FileAccess.Write, FileShare.None, BUFFER_SIZE, useAsync: true))
                {
                    downloadedBytes = 0;
                    byte[] buffer = new byte[BUFFER_SIZE];
                    int bytesRead;
                    int uiUpdateCounter = 0;

                    while ((bytesRead = await contentStream.ReadAsync(buffer, 0, buffer.Length, cancellationTokenSource.Token)) != 0)
                    {
                        await fileStream.WriteAsync(buffer, 0, bytesRead, cancellationTokenSource.Token);
                        downloadedBytes += bytesRead;
                        uiUpdateCounter++;

                        if (uiUpdateCounter >= 10)
                        {
                            uiUpdateCounter = 0;
                            UpdateDownloadProgress();
                        }
                    }
                    UpdateDownloadProgress();
                }
            }
        }

        private void UpdateDownloadProgress()
        {
            if (totalBytes <= 0) return;
            int percentage = (int)((downloadedBytes * 100) / totalBytes);
            
            DateTime now = DateTime.Now;
            double elapsedSeconds = (now - lastUpdateTime).TotalSeconds;
            double speed = 0;
            
            if (elapsedSeconds > 0)
            {
                speed = (downloadedBytes - lastDownloadedBytes) / elapsedSeconds / (1024 * 1024);
                lastUpdateTime = now;
                lastDownloadedBytes = downloadedBytes;
            }

            this.Invoke((MethodInvoker)(() =>
            {
                ProgressBar progressBar = (ProgressBar)this.Controls["progressBar"];
                Label statusLabel = (Label)this.Controls["statusLabel"];

                progressBar.Value = Math.Min(percentage, 100);
                
                double downloadedMB = downloadedBytes / (1024.0 * 1024.0);
                double totalMB = totalBytes / (1024.0 * 1024.0);
                
                statusLabel.Text = string.Format("Đang tải: {0:F2}MB / {1:F2}MB ({2}%) - {3:F2} MB/s", 
                    downloadedMB, totalMB, percentage, speed);
            }));
        }

        private void CancelBtn_Click(object sender, EventArgs e)
        {
            cancellationTokenSource.Cancel();
            this.Close();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            httpClient?.Dispose();
            cancellationTokenSource?.Dispose();
            base.OnFormClosing(e);
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
                    if (btn.Name == "downloadBtn") btn.BackColor = Color.FromArgb(0, 191, 165);
                    else btn.BackColor = Color.FromArgb(45, 45, 45);
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
