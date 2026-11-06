using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;

namespace Dorham.Monitor;

// Synthetic transport only. Tests never use a saved profile or contact a server.
public static class AdminSelfTest
{
    internal static AdminClient PreviewClient() => new("https://offline-preview.invalid", new FakeHandler { Modern = true });
    private sealed class FakeHandler : HttpMessageHandler
    {
        public bool Modern;
        public bool Forbidden;
        public bool Expired;
        public int CapabilityStatus = 200;
        public int Mutations;
        public bool LoggedOut;
        public string? LastBody;
        public bool LoginNative;
        public bool AuthenticatedRead;
        public bool RepeatPage;
        public int SpeechStatus = 400;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var path = request.RequestUri!.AbsolutePath;
            string body = request.Content == null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            HttpResponseMessage Reply(object value, int status = 200) => new((HttpStatusCode)status) { Content = new StringContent(JsonSerializer.Serialize(value), Encoding.UTF8, "application/json") };
            if (path.EndsWith("/auth/login"))
            {
                LoginNative = request.Headers.Contains("X-Dorham-Native");
                return Reply(new { accessToken = "fixture-token", user = new { id = "admin", username = "admin", displayName = "Admin", instanceAdmin = true } });
            }
            if (path.EndsWith("/auth/logout")) { LoggedOut = true; return Reply(new { success = true }); }
            if (Expired) return Reply(new { error = "fixture-secret-must-never-appear" }, 401);
            if (path.EndsWith("/admin/users"))
            {
                AuthenticatedRead = request.Headers.Authorization?.ToString() == "Bearer fixture-token";
                if (Forbidden) return Reply(new { error = "fixture-secret-must-never-appear" }, 403);
                bool later = request.RequestUri.Query.Contains("offset=250") && !RepeatPage;
                int count = Modern ? later ? 1 : 250 : 1;
                return Reply(new { users = Enumerable.Range(later ? 250 : 0, count).Select(i => new { id = "user-" + i, username = "member_" + i, displayName = "Member " + i }) });
            }
            if (path.EndsWith("/admin/capabilities"))
                return Modern ? Reply(new { version = 1, userActions = new[] { "ban", "unban", "revoke", "resetPassword", "setPassword", "delete" }, usersPagination = true, deletionMode = "anonymizeKeepMessages", featureManagement = true }, CapabilityStatus) : Reply(new { }, 404);
            if (path.EndsWith("/admin/features"))
                return Reply(new { features = new[] { "screen1080", "ttsPlus", "profilePlus", "emojiPlus", "soundboardPlus", "uploadsPlus", "communityPlus" }, catalog = Array.Empty<object>() });
            if (path.EndsWith("/admin/features/users/user-1"))
                return Reply(new { rank = "pro", grants = new { ttsPlus = 0 }, plusSelected = false });
            if (path.EndsWith("/admin/features/speech/preview"))
                return Reply(new { error = new { code = SpeechStatus == 502 ? "SPEECH_PREVIEW_FAILED" : "VALIDATION", message = "fixture-secret" } }, SpeechStatus);
            if (path.Contains("/admin/users/"))
            {
                Mutations++; LastBody = body;
                return body.Contains("resetPassword") ? Reply(new { success = true, temporaryPassword = "synthetic-once-password" }) : Reply(new { success = true });
            }
            return Reply(new { }, 404);
        }
    }

    public static async Task<int> Run()
    {
        int passed = 0;
        void Assert(bool value, string label) { if (!value) throw new InvalidOperationException("Admin check failed: " + label); passed++; }
        async Task Reject(Func<Task> work, string label) { bool rejected = false; try { await work(); } catch { rejected = true; } Assert(rejected, label); }
        foreach (var endpoint in new[] { "http://example.test", "https://operator:secret@example.test", "https://example.test/path", "https://example.test?query=1", "invalid" })
        {
            bool rejected = false; try { using var invalid = new AdminClient(endpoint); } catch (InvalidOperationException) { rejected = true; }
            Assert(rejected, "unsafe endpoint rejected");
        }
        var user = new ManagedUser("member", "member", "Member", false, false, false, false);
        var legacy = new FakeHandler();
        using (var client = new AdminClient("https://example.test", legacy))
        {
            await client.SignIn("admin", "synthetic-password");
            Assert(legacy.LoginNative && legacy.AuthenticatedRead, "native sign-in and authorized user listing");
            Assert(client.Supports("ban") && !client.Supports("setPassword") && !client.Supports("delete"), "legacy capabilities fail closed for new actions");
            await Reject(() => client.Act(user, "delete", confirmation: "member"), "legacy delete blocked");
            await Reject(() => client.Act(user with { InstanceAdmin = true }, "ban"), "protected account blocked");
            await Reject(() => client.Act(user with { Guest = true }, "resetPassword"), "guest password blocked");
            Assert(legacy.Mutations == 0, "client validation never sent mutation");
            Assert(await client.Act(user, "resetPassword") == "synthetic-once-password", "one-time generated password read");
            await client.Act(user, "ban"); await client.Act(user, "unban"); await client.Act(user, "revoke");
            Assert(legacy.Mutations == 4, "legacy actions supported");
            await client.SignOut(); Assert(!client.SignedIn && legacy.LoggedOut, "logout revokes current session and clears local state");
        }
        var modern = new FakeHandler { Modern = true };
        using (var client = new AdminClient("https://example.test", modern))
        {
            var users = await client.SignIn("admin", "synthetic-password");
            Assert(users.Count == 251 && client.Supports("delete") && client.Supports("setPassword"), "modern pagination and capabilities");
            await Reject(() => client.Act(user, "setPassword", "short"), "short password blocked");
            await Reject(() => client.Act(user, "delete", confirmation: "different"), "delete confirmation blocked");
            Assert(modern.Mutations == 0, "new action validation never sent mutation");
            await client.Act(user, "setPassword", "synthetic-chosen-password");
            using (var body = JsonDocument.Parse(modern.LastBody!))
                Assert(body.RootElement.GetProperty("password").GetString() == "synthetic-chosen-password" && Guid.TryParse(body.RootElement.GetProperty("requestId").GetString(), out _), "chosen password and unique request ID encoded as JSON");
            await client.Act(user, "delete", confirmation: "member");
            using (var body = JsonDocument.Parse(modern.LastBody!)) Assert(body.RootElement.GetProperty("confirmUsername").GetString() == "member" && !body.RootElement.TryGetProperty("password", out _), "delete sends confirmation without password");
            foreach (var (status, expected) in new[] { (400, "endpoint is approved"), (502, "provider could not generate a preview") })
            {
                modern.SpeechStatus = status;
                try
                {
                    using var preview = await client.FeatureRequest(HttpMethod.Post, "features/speech/preview", new { });
                    throw new InvalidOperationException("Expected the speech preview to be rejected.");
                }
                catch (AdminApiException error)
                {
                    Assert(error.Message.Contains(expected) && !error.Message.Contains("fixture-secret"), "speech preview error is specific and hides raw details");
                }
            }
            modern.Expired = true;
            try { await client.Users(); } catch (AdminApiException error) { Assert(!error.Message.Contains("fixture-secret"), "raw server errors never displayed"); }
            Assert(!client.SignedIn && !client.Supports("delete"), "expiry clears token and capabilities");
        }
        var unauthorized = new FakeHandler { Forbidden = true };
        using (var client = new AdminClient("https://example.test", unauthorized))
        {
            await Reject(() => client.SignIn("admin", "synthetic-password"), "backend authority checked despite admin login claim");
            Assert(!client.SignedIn && unauthorized.LoggedOut, "refused admin session revoked");
        }
        var discoveryFailure = new FakeHandler { Modern = true, CapabilityStatus = 503 };
        using (var client = new AdminClient("https://example.test", discoveryFailure))
        {
            await Reject(() => client.SignIn("admin", "synthetic-password"), "discovery failure does not enable fallback");
            Assert(!client.SignedIn && discoveryFailure.Mutations == 0, "discovery failure leaves no active client session");
        }
        var brokenPaging = new FakeHandler { Modern = true, RepeatPage = true };
        using (var client = new AdminClient("https://example.test", brokenPaging))
            await Reject(() => client.SignIn("admin", "synthetic-password"), "repeated pages rejected instead of unbounded reads");
        return passed;
    }
}
