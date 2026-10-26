// Online (Vercel) the owner's Refresh button can't crawl inside a short-lived function, so it starts
// the crawl job on GitHub Actions (.github/workflows/crawl.yml) through GitHub's API.
//   GITHUB_TOKEN  fine-grained token for this repository with "Actions: Read and write"
//   GITHUB_REPO   owner/name, e.g. t0dida00/iPromotions
//   GITHUB_REF    branch to run on (default main)
const WORKFLOW = 'crawl.yml';

// `segments`: section names to refresh, or null for every store.
export async function dispatchCrawl(segments) {
  const { GITHUB_TOKEN: token, GITHUB_REPO: repo, GITHUB_REF: ref = 'main' } = process.env;
  if (!token || !repo) throw new Error('GITHUB_TOKEN / GITHUB_REPO are not set');
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ ref, inputs: { segment: segments?.join(',') ?? '', trigger: 'manual' } }),
  });
  if (res.status !== 204) throw new Error(`GitHub answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
