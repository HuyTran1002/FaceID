using System;
using System.Reflection;
using System.Windows.Forms;
using System.IO;
using System.Net;
using System.Threading.Tasks;

namespace FaceID
{
    public class UpdateResult
    {
        public bool hasUpdate;
        public string latestVersion;
        public string downloadUrl;
    }

    public class UpdateChecker
    {
        private const string GITHUB_API_RELEASE_URL = "https://api.github.com/repos/HuyTran1002/FaceID/releases/latest";
        private static bool isShowingUpdateDialog = false;

        public static Version CurrentVersion
        {
            get
            {
                try
                {
                    var assembly = Assembly.GetEntryAssembly() ?? Assembly.GetExecutingAssembly();
                    var version = assembly.GetName().Version;
                    return version ?? new Version(1, 0, 0, 0);
                }
                catch { return new Version(1, 0, 0, 0); }
            }
        }

        public static async Task<UpdateResult> CheckForUpdateAsync()
        {
            string logPath = Path.Combine(Path.GetTempPath(), "FaceID_update_debug.log");
            try
            {
                // Sử dụng WebClient để tương thích tối đa với .NET cũ
                using (WebClient client = new WebClient())
                {
                    client.Headers.Add("User-Agent", "FaceID-Updater/5.0");
                    // Ép kiểu bảo mật TLS 1.2 cho GitHub (Bắt buộc)
                    ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; 

                    string response = client.DownloadString(GITHUB_API_RELEASE_URL);
                    
                    string tagName = ExtractValueFromJson(response, "tag_name");
                    string versionString = tagName.TrimStart('v', 'V');
                    string downloadUrl = ExtractExeUrlFromJson(response);

                    Version latestVersion;
                    if (Version.TryParse(versionString, out latestVersion))
                    {
                        bool hasUpdate = latestVersion > CurrentVersion;
                        return new UpdateResult { hasUpdate = hasUpdate, latestVersion = versionString, downloadUrl = downloadUrl };
                    }
                }
                return new UpdateResult { hasUpdate = false };
            }
            catch (Exception ex)
            {
                File.AppendAllText(logPath, "[" + DateTime.Now + "] Error: " + ex.Message + "\n");
                return new UpdateResult { hasUpdate = false };
            }
        }

        private static string ExtractValueFromJson(string json, string key)
        {
            string searchKey = "\"" + key + "\":\"";
            int start = json.IndexOf(searchKey);
            if (start == -1) return "";
            start += searchKey.Length;
            int end = json.IndexOf("\"", start);
            if (end == -1) return "";
            return json.Substring(start, end - start);
        }

        private static string ExtractExeUrlFromJson(string json)
        {
            string marker = "browser_download_url\":\"";
            string exeMarker = ".exe";
            int idx = json.IndexOf(marker);
            while (idx != -1)
            {
                int start = idx + marker.Length;
                int end = json.IndexOf(exeMarker, start);
                if (end != -1)
                {
                    end += exeMarker.Length;
                    string url = json.Substring(start, end - start);
                    if (url.EndsWith(".exe")) return url;
                }
                idx = json.IndexOf(marker, idx + 1);
            }
            return null;
        }

        public static void ShowAutoUpdateDialog(string latestVersion, string downloadUrl)
        {
            UpdateForm updateForm = new UpdateForm(latestVersion, downloadUrl);
            updateForm.ShowDialog();
        }
    }

    public static class Program
    {
        [STAThread]
        public static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var task = UpdateChecker.CheckForUpdateAsync();
            task.Wait();
            var result = task.Result;
            
            if (result.hasUpdate)
            {
                UpdateChecker.ShowAutoUpdateDialog(result.latestVersion, result.downloadUrl);
            }
            else
            {
                MessageBox.Show("Bạn đang sử dụng phiên bản mới nhất (v" + UpdateChecker.CurrentVersion + ")", "Thông báo", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }
    }
}
