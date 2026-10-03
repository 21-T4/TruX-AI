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

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(String(value));
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

function base64ToUtf8(value) {
  const normalized = String(value || '').replace(/\s/g, '');
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const GITHUB_REQUEST_TIMEOUT_MS = 15000;

async function githubRequest(session, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + session.token,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'TruX-Code',
        ...(options.headers || {})
      }
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('GitHub request timed out after 15 seconds.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function countExact(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = source.indexOf(needle, from);
    if (i < 0) return count;
    count++;
    from = i + needle.length;
    if (count > 1) return count;
  }
}

export async function onRequestPost({ request, env }) {
  try {
    const session = await getGithubSession(request, env);
    if (!session?.token) {
      return Response.json({ error: 'Connect GitHub before applying repository changes.' }, { status: 401 });
    }

    const body = await request.json();
    const { repository, branch, edits, message, confirmed } = body || {};

    if (confirmed !== true) {
      return Response.json({ error: 'Explicit confirmation is required before writing to GitHub.' }, { status: 400 });
    }

    if (!validRepo(repository) || !Array.isArray(edits) || !edits.length) {
      return Response.json({ error: 'Invalid GitHub edit request.' }, { status: 400 });
    }

    // Resolve the target branch and capture its exact current head before doing
    // anything that can mutate the repository. All edits are validated first.
    const repoResponse = await githubRequest(session, `https://api.github.com/repos/${repository}`);
    const repoPayload = await repoResponse.json().catch(() => ({}));
    if (!repoResponse.ok || !repoPayload?.default_branch) {
      return Response.json({
        error: repoPayload?.message || 'Could not resolve the GitHub repository.'
      }, { status: repoResponse.status || 502 });
    }

    const targetBranch = String(branch || repoPayload.default_branch).trim();
    if (!targetBranch || targetBranch.length > 250) {
      return Response.json({ error: 'Invalid target branch.' }, { status: 400 });
    }

    const branchPath = targetBranch.split('/').map(encodeURIComponent).join('/');
    const refResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/ref/heads/${branchPath}`
    );
    const refPayload = await refResponse.json().catch(() => ({}));

    if (!refResponse.ok || !refPayload?.object?.sha) {
      return Response.json({
        error: refPayload?.message || `Could not read branch ${targetBranch} before applying the changes.`
      }, { status: refResponse.status || 502 });
    }

    const headSha = String(refPayload.object.sha);
    const headCommitResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/commits/${headSha}`
    );
    const headCommitPayload = await headCommitResponse.json().catch(() => ({}));

    if (!headCommitResponse.ok || !headCommitPayload?.sha || !headCommitPayload?.tree?.sha) {
      return Response.json({
        error: headCommitPayload?.message || 'Could not read the current branch tree.'
      }, { status: headCommitResponse.status || 502 });
    }

    const planned = [];
    const seenPaths = new Set();
    const groupedEdits = new Map();

    // Validate every fragment against the same captured branch head. Repeated
    // paths are valid; only overlapping fragments are rejected.
    for (const edit of edits) {
      const path = edit?.path;
      const oldText = typeof edit?.oldText === 'string' ? edit.oldText : '';
      const newText = typeof edit?.newText === 'string' ? edit.newText : '';

      if (!validPath(path) || oldText.length < 1) {
        return Response.json({ error: 'Invalid edit payload for ' + String(path || 'unknown') + '.' }, { status: 400 });
      }

      if (!groupedEdits.has(path)) groupedEdits.set(path, []);
      groupedEdits.get(path).push({ oldText, newText });
      seenPaths.add(path);
    }

    for (const [path, pathEdits] of groupedEdits.entries()) {
      const query = `?ref=${encodeURIComponent(targetBranch)}`;
      const filePath = path.split('/').map(encodeURIComponent).join('/');
      const fileResponse = await githubRequest(
        session,
        `https://api.github.com/repos/${repository}/contents/${filePath}${query}`
      );
      const filePayload = await fileResponse.json().catch(() => ({}));

      if (!fileResponse.ok || !filePayload?.content || !filePayload?.sha) {
        return Response.json({
          error: `Could not read ${path} before applying the change: ${filePayload?.message || 'GitHub returned an error.'}`
        }, { status: fileResponse.status || 502 });
      }

      const currentContent = base64ToUtf8(filePayload.content);
      const placements = pathEdits.map(edit => {
        const first = currentContent.indexOf(edit.oldText);
        const second = first < 0 ? -1 : currentContent.indexOf(edit.oldText, first + edit.oldText.length);
        if (first < 0 || second >= 0) return null;
        return { start: first, end: first + edit.oldText.length, newText: edit.newText };
      });

      if (placements.some(placement => !placement)) {
        return Response.json({
          error: `The file ${path} changed since the proposal was prepared, so one or more exact edits could not be applied safely.`,
          conflict: true,
          path
        }, { status: 409 });
      }

      placements.sort((x, y) => x.start - y.start);
      for (let i = 1; i < placements.length; i++) {
        if (placements[i].start < placements[i - 1].end) {
          return Response.json({
            error: `Overlapping GitHub edits were requested for ${path}. Combine only the overlapping fragments.`,
            conflict: true,
            path
          }, { status: 409 });
        }
      }

      let nextContent = '';
      let cursor = 0;
      for (const placement of placements) {
        nextContent += currentContent.slice(cursor, placement.start);
        nextContent += placement.newText;
        cursor = placement.end;
      }
      nextContent += currentContent.slice(cursor);

      planned.push({ path, content: nextContent });
    }

    // Store large edited files as Git blobs in parallel, then create one compact
    // tree from blob SHAs. This is substantially more efficient for large changes.
    const blobResults = await Promise.all(planned.map(async edit => {
      const blobResponse = await githubRequest(
        session,
        `https://api.github.com/repos/${repository}/git/blobs`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: utf8ToBase64(edit.content),
            encoding: 'base64'
          })
        }
      );
      const blobPayload = await blobResponse.json().catch(() => ({}));
      if (!blobResponse.ok || !blobPayload?.sha) {
        throw new Error(blobPayload?.message || `GitHub could not store the edited file ${edit.path}.`);
      }
      return { path: edit.path, sha: String(blobPayload.sha) };
    }));

    const treeResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/trees`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_tree: headCommitPayload.tree.sha,
          tree: blobResults.map(edit => ({
            path: edit.path,
            mode: '100644',
            type: 'blob',
            sha: edit.sha
          }))
        })
      }
    );
    const treePayload = await treeResponse.json().catch(() => ({}));

    if (!treeResponse.ok || !treePayload?.sha) {
      return Response.json({
        error: treePayload?.message || 'GitHub could not prepare the combined change.'
      }, { status: treeResponse.status || 502 });
    }

    const commitMessage = String(message || 'Update files with TruX-Code').slice(0, 250);
    const commitResponse = await githubRequest(
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
    const commitPayload = await commitResponse.json().catch(() => ({}));

    if (!commitResponse.ok || !commitPayload?.sha) {
      return Response.json({
        error: commitPayload?.message || 'GitHub could not create the commit.'
      }, { status: commitResponse.status || 502 });
    }

    const commitSha = String(commitPayload.sha);
    const updateResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/refs/heads/${branchPath}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: commitSha, force: false })
      }
    );
    const updatePayload = await updateResponse.json().catch(() => ({}));

    if (!updateResponse.ok) {
      const branchConflict = updateResponse.status === 409 || updateResponse.status === 422;
      return Response.json({
        error: branchConflict
          ? 'The branch changed while the reviewed edits were being applied. Nothing was force-pushed; review the latest changes and try again.'
          : (updatePayload?.message || 'GitHub could not update the target branch.'),
        conflict: branchConflict,
        commit: commitSha
      }, { status: branchConflict ? 409 : (updateResponse.status || 502) });
    }

    // Verify the ref moved to exactly this commit and every edited file in that
    // immutable commit contains the expected post-edit content.
    const verifyRefResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/ref/heads/${branchPath}`
    );
    const verifyRefPayload = await verifyRefResponse.json().catch(() => ({}));

    if (!verifyRefResponse.ok || verifyRefPayload?.object?.sha !== commitSha) {
      return Response.json({
        error: 'GitHub accepted the write, but the branch verification did not match the new commit.',
        conflict: true,
        commit: commitSha
      }, { status: 502 });
    }

    const results = [];
    for (const edit of planned) {
      const filePath = edit.path.split('/').map(encodeURIComponent).join('/');
      const verifyResponse = await githubRequest(
        session,
        `https://api.github.com/repos/${repository}/contents/${filePath}?ref=${encodeURIComponent(commitSha)}`
      );
      const verifyPayload = await verifyResponse.json().catch(() => ({}));

      if (!verifyResponse.ok || !verifyPayload?.content) {
        return Response.json({
          error: `The commit was created, but ${edit.path} could not be verified afterward.`,
          conflict: true,
          commit: commitSha,
          path: edit.path
        }, { status: 502 });
      }

      const verifiedContent = base64ToUtf8(verifyPayload.content);
      if (verifiedContent !== edit.content) {
        return Response.json({
          error: `The commit was created, but the saved content for ${edit.path} did not match the requested edit.`,
          conflict: true,
          commit: commitSha,
          path: edit.path
        }, { status: 502 });
      }

      results.push({ path: edit.path, verified: true });
    }

    return Response.json({
      ok: true,
      applied: true,
      verified: true,
      repository,
      branch: targetBranch,
      commit: {
        sha: commitSha,
        shortSha: commitSha.slice(0, 7),
        message: commitMessage,
        url: commitPayload?.html_url || `https://github.com/${repository}/commit/${commitSha}`
      },
      results
    });
  } catch (error) {
    console.error('GitHub apply-edits failed', error);
    return Response.json({ error: error?.message || 'GitHub edit failed.' }, { status: 500 });
  }
}
