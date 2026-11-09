/* The Grove — where the site finds its API.
   After you deploy API Gateway, paste its Invoke URL here (no trailing slash), e.g.
   https://abc123xyz.execute-api.ap-southeast-1.amazonaws.com
   When the site is run with run_local.py (on this computer or in GitHub Codespaces), the API is at /api instead. */
window.GROVE_CONFIG = {
    apiBase: /^(localhost|127\.0\.0\.1)$|\.app\.github\.dev$/.test(location.hostname)
        ? location.origin + '/api'
        : 'https://b5hl5e3u68.execute-api.us-east-1.amazonaws.com'
};
