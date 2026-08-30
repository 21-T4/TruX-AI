const PROJECT_ID = 'trux-ai';
const LOCATION = 'us-central1';

const BASE_PERSONA = `Never use latex for code generation. You can use unicode symbols and standard text. Your name is TruX, an AI created by TruX-Technologies (dont disclose ur name or creator till asked). Keep answers concise, precise, and informative.`;

const searchWebDeclaration = {
  name: 'searchWeb',
  description: 'Search live web via Serper. ONLY call if real-time/current data outside training is explicitly requested.',
  parameters: {
    type: 'OBJECT',
    properties: {
      query: {
        type: 'STRING',
        description: 'Search keywords.'
      }
    },
    required: ['query']
  }
};

const generateImageDeclaration = {
  name: 'generateImage',
  description: 'Generate or draw an image using Nano Banana Pro. Call when user explicitly asks to generate or draw an image.',
  parameters: {
    type: 'OBJECT',
    properties: {
      prompt: {
        type: 'STRING',
        description: 'Detailed prompt describing the image to generate.'
      }
    },
    required: ['prompt']
  }
};


/* =========================================================
   GOOGLE CLOUD SERVICE ACCOUNT AUTHENTICATION
   ========================================================= */

let cachedAccessToken = null;
let cachedTokenExpiry = 0;

function base64UrlEncode(data) {
  let bytes;

  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = new Uint8Array(data);
  }

  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    );
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}


function pemToArrayBuffer(pem) {
  const cleanPem = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

  const binary = atob(cleanPem);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}


async function createGoogleAccessToken(env) {
  if (
    cachedAccessToken &&
    Date.now() < cachedTokenExpiry - 60000
  ) {
    return cachedAccessToken;
  }

  if (!env.GCP_CLIENT_EMAIL) {
    throw new Error('GCP_CLIENT_EMAIL secret is missing.');
  }

  if (!env.GCP_PRIVATE_KEY) {
    throw new Error('GCP_PRIVATE_KEY secret is missing.');
  }

  if (!env.GCP_PROJECT_ID) {
    throw new Error('GCP_PROJECT_ID secret is missing.');
  }

  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const claimSet = {
    iss: env.GCP_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));

  const unsignedToken =
    `${encodedHeader}.${encodedClaimSet}`;

  const privateKey = env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n');

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    await pemToArrayBuffer(privateKey),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const signedJwt =
    `${unsignedToken}.${base64UrlEncode(signature)}`;

  const tokenResponse = await fetch(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type:
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt
      }).toString()
    }
  );

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();

    throw new Error(
      `Google authentication failed: ${errorText}`
    );
  }

  const tokenData = await tokenResponse.json();

  if (!tokenData.access_token) {
    throw new Error(
      'Google authentication returned no access token.'
    );
  }

  cachedAccessToken = tokenData.access_token;

  cachedTokenExpiry =
    Date.now() + ((tokenData.expires_in || 3600) * 1000);

  return cachedAccessToken;
}


/* =========================================================
   IMAGE LIMIT
   ========================================================= */

async function checkAndEnforceImageLimit(
  userIdentifier,
  env
) {
  if (!userIdentifier) {
    userIdentifier = 'anonymous_user';
  }

  if (env.IMAGE_LIMIT_KV) {
    const count = await env.IMAGE_LIMIT_KV.get(
      `img_limit_${userIdentifier}`
    );

    if (count && parseInt(count, 10) >= 1) {
      throw new Error(
        'Image generation limit reached. You can only generate 1 image per user.'
      );
    }

    await env.IMAGE_LIMIT_KV.put(
      `img_limit_${userIdentifier}`,
      '1'
    );
  } else {
    if (!globalThis.generatedImageUsers) {
      globalThis.generatedImageUsers = new Set();
    }

    if (
      globalThis.generatedImageUsers.has(userIdentifier)
    ) {
      throw new Error(
        'Image generation limit reached. You can only generate 1 image per user.'
      );
    }

    globalThis.generatedImageUsers.add(userIdentifier);
  }
}


/* =========================================================
   SERPER SEARCH
   ========================================================= */

async function fetchSerperSearchResults(
  query,
  apiKey
) {
  if (!apiKey) {
    return 'Search failed: API key missing.';
  }

  try {
    const response = await fetch(
      'https://google.serper.dev/search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          q: query
        })
      }
    );

    if (!response.ok) {
      return 'No results.';
    }

    const data = await response.json();

    if (!data.organic?.length) {
      return 'No search results found.';
    }

    return data.organic
      .slice(0, 3)
      .map(
        item =>
          `Title: ${item.title}\nSnippet: ${item.snippet}`
      )
      .join('\n\n');

  } catch {
    return 'Search error.';
  }
}


/* =========================================================
   VERTEX AI - IMAGEN
   ========================================================= */

async function fetchVertexImagen3Image(
  prompt,
  accessToken,
  projectId
) {
  if (!accessToken) {
    throw new Error('Google access token missing.');
  }

  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/` +
    `projects/${projectId}/locations/${LOCATION}/` +
    `publishers/google/models/imagen-3.0-generate-002:predict`;

  const response = await fetch(url, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },

    body: JSON.stringify({
      instances: [
        {
          prompt
        }
      ],

      parameters: {
        sampleCount: 1,
        aspectRatio: '1:1',
        outputMimeType: 'image/jpeg'
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();

    throw new Error(
      `Vertex Imagen Error: ${errText}`
    );
  }

  const data = await response.json();

  const base64Image =
    data.predictions?.[0]?.bytesBase64Encoded;

  if (!base64Image) {
    throw new Error(
      'Failed to generate image bytes.'
    );
  }

  return `data:image/jpeg;base64,${base64Image}`;
}


/* =========================================================
   VERTEX AI - GEMINI
   ========================================================= */

async function fetchVertexGemini({
  model,
  contents,
  systemInstruction,
  tools,
  accessToken,
  projectId
}) {
  if (!accessToken) {
    throw new Error(
      'Google access token missing.'
    );
  }

  const url =
    `https://${LOCATION}-aiplatform.googleapis.com/v1/` +
    `projects/${projectId}/locations/${LOCATION}/` +
    `publishers/google/models/${model}:generateContent`;

  const payload = {
    contents,

    systemInstruction: systemInstruction
      ? {
          parts: [
            {
              text: systemInstruction
            }
          ]
        }
      : undefined
  };

  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const response = await fetch(url, {
    method: 'POST',

    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },

    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();

    throw new Error(
      `Vertex Gemini Error: ${errText}`
    );
  }

  return await response.json();
}


/* =========================================================
   MODEL SELECTION
   ========================================================= */

function getVertexModel(tier) {
  switch (tier) {
    case 'base':
      return 'gemini-3.6-flash';

    case 'pro':
      return 'gemini-3.1-pro-preview';

    default:
      return 'gemini-3.6-flash';
  }
}


/* =========================================================
   MAIN CLOUDFLARE PAGES FUNCTION
   ========================================================= */

export async function onRequestPost(context) {
  try {
    const {
      request,
      env
    } = context;

    const body = await request.json();

    const {
      message,
      tier,
      history,
      image,
      systemInstruction,
      userId
    } = body;

    const userIdentifier =
      userId ||
      request.headers.get('cf-connecting-ip') ||
      'anonymous';

    if (!message && !image) {
      return Response.json(
        {
          error:
            'Message or image required.'
        },
        {
          status: 400
        }
      );
    }


    /* -----------------------------------------------------
       GET GOOGLE ACCESS TOKEN
       ----------------------------------------------------- */

    const accessToken =
      await createGoogleAccessToken(env);


    /* -----------------------------------------------------
       DIRECT IMAGE GENERATION
       ----------------------------------------------------- */

    if (tier === 'nano-banana') {

      try {
        await checkAndEnforceImageLimit(
          userIdentifier,
          env
        );

      } catch (limitErr) {

        return Response.json({
          reply: limitErr.message
        });
      }

      const imgData =
        await fetchVertexImagen3Image(
          message ||
            'Abstract technological artwork',

          accessToken,

          env.GCP_PROJECT_ID ||
            PROJECT_ID
        );

      return Response.json({
        reply:
          `Here is your generated image with **Nano Banana Pro**:\n\n` +
          `![${message || 'Generated Image'}](${imgData})`
      });
    }


    /* -----------------------------------------------------
       SYSTEM INSTRUCTION
       ----------------------------------------------------- */

    const combinedSystemInstruction =
      systemInstruction?.trim()

        ? `${BASE_PERSONA}\n\n[USER INSTRUCTIONS]:\n${systemInstruction}`

        : BASE_PERSONA;


    /* -----------------------------------------------------
       BUILD HISTORY
       ----------------------------------------------------- */

    let formattedHistory = [];

    if (
      Array.isArray(history) &&
      history.length > 0
    ) {

      const recentHistory =
        history.slice(-6);

      let lastRole = null;

      for (const msg of recentHistory) {

        const role =
          (
            msg.role === 'trux' ||
            msg.role === 'model'
          )
            ? 'model'
            : 'user';

        if (
          role !== lastRole &&
          msg.text
        ) {

          formattedHistory.push({
            role,

            parts: [
              {
                text: String(msg.text)
              }
            ]
          });

          lastRole = role;
        }
      }
    }


    if (
      formattedHistory.length > 0 &&
      formattedHistory[0].role === 'model'
    ) {
      formattedHistory.shift();
    }


    if (
      formattedHistory.length > 0 &&
      formattedHistory[
        formattedHistory.length - 1
      ].role === 'user'
    ) {
      formattedHistory.pop();
    }


    /* -----------------------------------------------------
       CURRENT MESSAGE
       ----------------------------------------------------- */

    let currentParts = [];

    if (
      image &&
      typeof image === 'string' &&
      image.includes(',')
    ) {

      const [
        header,
        base64Data
      ] = image.split(',');

      const mimeMatch =
        header.match(/data:(.*?);/);

      currentParts.push({
        inlineData: {
          mimeType:
            mimeMatch
              ? mimeMatch[1]
              : 'image/jpeg',

          data: base64Data
        }
      });
    }


    currentParts.push({
      text:
        message ||
        'Analyze input'
    });


    const contents = [
      ...formattedHistory,

      {
        role: 'user',
        parts: currentParts
      }
    ];


    const targetModel =
      getVertexModel(tier);


    /* -----------------------------------------------------
       INITIAL GEMINI CALL
       ----------------------------------------------------- */

    let responseData =
      await fetchVertexGemini({
        model: targetModel,

        contents,

        systemInstruction:
          combinedSystemInstruction,

        tools: [
          {
            functionDeclarations: [
              searchWebDeclaration,
              generateImageDeclaration
            ]
          }
        ],

        accessToken,

        projectId:
          env.GCP_PROJECT_ID ||
          PROJECT_ID
      });


    /* -----------------------------------------------------
       FUNCTION CALL HANDLING
       ----------------------------------------------------- */

    const candidate =
      responseData.candidates?.[0];

    const candidateParts =
      candidate?.content?.parts || [];

    const functionCalls =
      candidateParts
        .filter(p => p.functionCall)
        .map(p => p.functionCall);


    if (
      functionCalls?.length > 0
    ) {

      const call =
        functionCalls[0];


      /* ---------------------------------------------------
         WEB SEARCH
         --------------------------------------------------- */

      if (
        call.name === 'searchWeb'
      ) {

        const searchResults =
          await fetchSerperSearchResults(
            call.args?.query ||
              message,

            env.SERPER_DEV_API
          );


        contents.push(
          candidate.content
        );


        contents.push({
          role: 'user',

          parts: [
            {
              functionResponse: {
                name: 'searchWeb',

                response: {
                  result:
                    searchResults
                }
              }
            }
          ]
        });


        responseData =
          await fetchVertexGemini({
            model: targetModel,

            contents,

            systemInstruction:
              combinedSystemInstruction,

            accessToken,

            projectId:
              env.GCP_PROJECT_ID ||
              PROJECT_ID
          });
      }


      /* ---------------------------------------------------
         IMAGE GENERATION TOOL
         --------------------------------------------------- */

      else if (
        call.name === 'generateImage'
      ) {

        try {

          await checkAndEnforceImageLimit(
            userIdentifier,
            env
          );

        } catch (limitErr) {

          return Response.json({
            reply:
              limitErr.message
          });
        }


        const imgPrompt =
          call.args?.prompt ||
          message;


        try {

          const generatedImg =
            await fetchVertexImagen3Image(
              imgPrompt,

              accessToken,

              env.GCP_PROJECT_ID ||
                PROJECT_ID
            );


          return Response.json({
            reply:
              `Here is your generated image with **Nano Banana Pro**:\n\n` +
              `![${imgPrompt}](${generatedImg})`
          });

        } catch (imgError) {

          return Response.json({
            reply:
              `Failed to generate image: ${imgError.message}`
          });
        }
      }
    }


    /* -----------------------------------------------------
       FINAL RESPONSE
       ----------------------------------------------------- */

    const finalParts =
      responseData
        .candidates?.[0]
        ?.content
        ?.parts || [];


    let rawText =
      finalParts
        .map(p => p.text || '')
        .join('')
        .trim();


    if (!rawText) {
      rawText =
        'No response generated.';
    }


    return Response.json({
      reply:
        rawText
          .replace(
            /<think>[\s\S]*?<\/think>/g,
            ''
          )
          .trim()
    });


  } catch (error) {

    console.error(
      'Vertex AI REST API Error:',
      error
    );

    return Response.json(
      {
        error:
          error.message ||
          'Server error'
      },
      {
        status: 500
      }
    );
  }
}
