import { getGithubSession } from '../../github-session.js';

function validRepo(value) {
  return /^[\w.-]+\/[\w.-]+$/.test(String(value || ''));
}

function validPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length < 500
    && !value.split('/').includes('..');
}

async function githubRequest(session, url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + session.token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'TruX-Code',
      ...(options.headers || {})
    }
  });
}

async function readRef(session, repository, branch) {
  const branchPath = branch.split('/').map(encodeURIComponent).join('/');
  const response = await githubRequest(
    session,
    `https://api.github.com/repos/${repository}/git/ref/heads/${branchPath}`
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.object?.sha) {
    throw new Error(payload?.message || `Could not read branch ${branch}.`);
  }
  return { branchPath, headSha: String(payload.object.sha) };
}

export async function onRequestPost({ request, env }) {
  try {
    const session = await getGithubSession(request, env);
    if (!session?.token) {
      return Response.json({ error: 'Connect GitHub before editing a repository.' }, { status: 401 });
    }

    const body = await request.json();
    const {
      repository,
      branch: requestedBranch,
      path,
      content,
      sha: expectedFileSha,
      message,
      confirmed
    } = body || {};

    if (confirmed !== true) {
      return Response.json({ error: 'Explicit confirmation is required before writing to GitHub.' }, { status: 400 });
    }
    if (!validRepo(repository) || !validPath(path) || typeof content !== 'string') {
      return Response.json({ error: 'Invalid repository edit request.' }, { status: 400 });
    }

    let targetBranch = String(requestedBranch || '').trim();
    if (!targetBranch) {
      const repoResponse = await githubRequest(session, `https://api.github.com/repos/${repository}`);
      const repoPayload = await repoResponse.json().catch(() => ({}));
      if (!repoResponse.ok || !repoPayload?.default_branch) {
        return Response.json({
          error: repoPayload?.message || 'Could not resolve the GitHub repository.'
        }, { status: repoResponse.status || 502 });
      }
      targetBranch = String(repoPayload.default_branch).trim();
    }
    if (!targetBranch || targetBranch.length > 250) {
      return Response.json({ error: 'Invalid target branch.' }, { status: 400 });
    }

    const { branchPath, headSha } = await readRef(session, repository, targetBranch);

    const currentResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/contents/` +
      path.split('/').map(encodeURIComponent).join('/') +
      `?ref=${encodeURIComponent(headSha)}`,
      { headers: { Accept: 'application/vnd.github.object+json, application/vnd.github+json' } }
    );
    const currentPayload = await currentResponse.json().catch(() => ({}));
    if (!currentResponse.ok || !currentPayload?.sha) {
      return Response.json({
        error: currentPayload?.message || `Could not read ${path} before editing.`
      }, { status: currentResponse.status || 502 });
    }

    if (expectedFileSha && String(expectedFileSha) !== String(currentPayload.sha)) {
      return Response.json({
        error: `The file ${path} changed since it was read. Re-read it before applying this edit.`,
        conflict: true,
        path
      }, { status: 409 });
    }

    const blobResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/blobs`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, encoding: 'utf-8' })
      }
    );
    const blobPayload = await blobResponse.json().catch(() => ({}));
    if (!blobResponse.ok || !blobPayload?.sha) {
      return Response.json({
        error: blobPayload?.message || `GitHub could not store ${path}.`
      }, { status: blobResponse.status || 502 });
    }

    const commitResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/commits/${headSha}`
    );
    const commitPayload = await commitResponse.json().catch(() => ({}));
    if (!commitResponse.ok || !commitPayload?.tree?.sha) {
      return Response.json({
        error: commitPayload?.message || 'Could not read the current branch tree.'
      }, { status: commitResponse.status || 502 });
    }

    const treeResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/trees`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_tree: commitPayload.tree.sha,
          tree: [{ path, mode: '100644', type: 'blob', sha: String(blobPayload.sha) }]
        })
      }
    );
    const treePayload = await treeResponse.json().catch(() => ({}));
    if (!treeResponse.ok || !treePayload?.sha) {
      return Response.json({
        error: treePayload?.message || 'GitHub could not prepare the edit tree.'
      }, { status: treeResponse.status || 502 });
    }

    const commitMessage = String(message || `Update ${path} with TruX-Code`).slice(0, 250);
    const newCommitResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/commits`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: commitMessage,
          tree: treePayload.sha,
          parents: [headSha]
        })
      }
    );
    const newCommit = await newCommitResponse.json().catch(() => ({}));
    if (!newCommitResponse.ok || !newCommit?.sha) {
      return Response.json({
        error: newCommit?.message || 'GitHub could not create the commit.'
      }, { status: newCommitResponse.status || 502 });
    }

    const updateResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/refs/heads/${branchPath}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: String(newCommit.sha), force: false })
      }
    );
    const updatePayload = await updateResponse.json().catch(() => ({}));
    if (!updateResponse.ok) {
      const conflict = updateResponse.status === 409 || updateResponse.status === 422;
      return Response.json({
        error: conflict
          ? 'The branch changed while this edit was being prepared. Re-read the file and try again; nothing was force-pushed.'
          : (updatePayload?.message || 'GitHub could not update the target branch.'),
        conflict,
        commit: String(newCommit.sha)
      }, { status: conflict ? 409 : (updateResponse.status || 502) });
    }

    const verifyRef = await readRef(session, repository, targetBranch);
    if (verifyRef.headSha !== String(newCommit.sha)) {
      return Response.json({
        error: 'GitHub accepted the commit, but branch verification did not match.',
        conflict: true,
        commit: String(newCommit.sha)
      }, { status: 502 });
    }

    const verifyResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/contents/` +
      path.split('/').map(encodeURIComponent).join('/') +
      `?ref=${encodeURIComponent(String(newCommit.sha))}`,
      { headers: { Accept: 'application/vnd.github.object+json, application/vnd.github+json' } }
    );
    const verifyPayload = await verifyResponse.json().catch(() => ({}));
    if (!verifyResponse.ok || String(verifyPayload?.sha || '') !== String(blobPayload.sha)) {
      return Response.json({
        error: `The commit was created, but ${path} could not be verified afterward.`,
        conflict: true,
        commit: String(newCommit.sha),
        path
      }, { status: 502 });
    }

    return Response.json({
      ok: true,
      applied: true,
      verified: true,
      repository,
      branch: targetBranch,
      path,
      commit: {
        sha: String(newCommit.sha),
        shortSha: String(newCommit.sha).slice(0, 7),
        message: commitMessage,
        url: newCommit?.html_url || `https://github.com/${repository}/commit/${newCommit.sha}`
      }
    });
  } catch (error) {
    console.error('GitHub legacy commit endpoint failed', error);
    return Response.json({ error: error?.message || 'GitHub edit failed.' }, { status: 500 });
  }
}
