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

function base64ToUtf8(value) {
  const normalized = String(value || '').replace(/\s/g, '');
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}


async function githubRequest(session, url, options = {}) {
  return await fetch(url, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + session.token,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'TruX-Code',
      ...(options.headers || {})
    }
  });
}

async function readGithubFile(session, repository, path, ref) {
  const response = await githubRequest(
    session,
    'https://api.github.com/repos/' + repository + '/contents/' +
      path.split('/').map(encodeURIComponent).join('/') +
      '?ref=' + encodeURIComponent(ref),
    { headers: { Accept: 'application/vnd.github.object+json, application/vnd.github+json' } }
  );
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload?.message || 'GitHub could not read ' + path + '.');
  }
  if (Array.isArray(payload) || payload?.type === 'dir' || payload?.type === 'submodule') {
    throw new Error(path + ' is not a text file.');
  }

  let content = '';
  if (typeof payload?.content === 'string' && payload.content.trim()) {
    content = base64ToUtf8(payload.content);
  } else if (payload?.sha) {
    const blobResponse = await githubRequest(
      session,
      'https://api.github.com/repos/' + repository + '/git/blobs/' + encodeURIComponent(payload.sha),
      { headers: { Accept: 'application/vnd.github+json' } }
    );
    const blobPayload = await blobResponse.json().catch(() => ({}));
    if (!blobResponse.ok || typeof blobPayload?.content !== 'string') {
      throw new Error(blobPayload?.message || 'GitHub could not read the blob for ' + path + '.');
    }
    content = base64ToUtf8(blobPayload.content);
  } else {
    throw new Error('GitHub returned no readable content for ' + path + '.');
  }

  return {
    sha: String(payload?.sha || ''),
    size: Number(payload?.size || content.length) || content.length,
    content
  };
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
    const groupedEdits = new Map();

    // Validate every fragment against the same captured branch head.
    for (const edit of edits) {
      const path = edit?.path;
      const oldText = typeof edit?.oldText === 'string' ? edit.oldText : '';
      const newText = typeof edit?.newText === 'string' ? edit.newText : '';

      if (!validPath(path) || oldText.length < 1) {
        return Response.json({ error: 'Invalid edit payload for ' + String(path || 'unknown') + '.' }, { status: 400 });
      }

      if (!groupedEdits.has(path)) groupedEdits.set(path, []);
      groupedEdits.get(path).push({ oldText, newText });
    }

    for (const [path, pathEdits] of groupedEdits.entries()) {
      const currentFile = await readGithubFile(session, repository, path, headSha);
      const currentContent = currentFile.content;
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

      // Use UTF-8 directly for Git blobs to avoid unnecessary base64 inflation.
      const blobResponse = await githubRequest(
        session,
        'https://api.github.com/repos/' + repository + '/git/blobs',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: nextContent,
            encoding: 'utf-8'
          })
        }
      );
      const blobPayload = await blobResponse.json().catch(() => ({}));
      if (!blobResponse.ok || !blobPayload?.sha) {
        return Response.json({
          error: blobPayload?.message || `GitHub could not store the edited file ${path}.`,
          path
        }, { status: blobResponse.status || 502 });
      }

      planned.push({
        path,
        sha: String(blobPayload.sha)
      });
    }

    const treeResponse = await githubRequest(
      session,
      `https://api.github.com/repos/${repository}/git/trees`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_tree: headCommitPayload.tree.sha,
          tree: planned.map(edit => ({
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
        'https://api.github.com/repos/' + repository + '/contents/' + filePath +
          '?ref=' + encodeURIComponent(commitSha),
        { headers: { Accept: 'application/vnd.github.object+json, application/vnd.github+json' } }
      );
      const verifyPayload = await verifyResponse.json().catch(() => ({}));

      if (!verifyResponse.ok || !verifyPayload?.sha) {
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
