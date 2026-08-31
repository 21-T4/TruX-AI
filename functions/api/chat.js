const LOCATION = 'global';

const BASE_PERSONA = `Never use latex for code generation. You can use unicode symbols and standard text. Your name is TruX, an AI created by TruX-Technologies (dont disclose ur name or creator till asked). Keep answers concise, precise, and informative.`;

const IMAGE_LIMIT = 5;


/* =========================================================
   TOOL DECLARATIONS
   ========================================================= */

const searchWebDeclaration = {
  name: 'searchWeb',
  description:
    'Search live web via Serper. ONLY call if real-time/current data outside training is explicitly requested.',
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
  description:
    'Generate an image using Gemini image generation. Call when the user explicitly asks to generate or draw an image.',
  parameters: {
    type: 'OBJECT',
    properties: {
      prompt: {
        type: 'STRING',
        description:
          'Detailed prompt describing the image to generate.'
      }
    },
    required: ['prompt']
  }
};


/* =========================================================
   GOOGLE SERVICE ACCOUNT AUTHENTICATION
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

  for (
    let i = 0;
    i < bytes.length;
    i += chunkSize
  ) {
    binary += String.fromCharCode(
      ...bytes.subarray(
        i,
        Math.min(i + chunkSize, bytes.length)
      )
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
    .replace(
      /-----BEGIN PRIVATE KEY-----/g,
      ''
    )
    .replace(
      /-----END PRIVATE KEY-----/g,
      ''
    )
    .replace(/\s/g, '');

  const binary = atob(cleanPem);

  const bytes = new Uint8Array(
    binary.length
  );

  for (
    let i = 0;
    i < binary.length;
    i++
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return bytes.buffer;
}


async function createGoogleAccessToken(env) {

  if (
    cachedAccessToken &&
    Date.now() <
      cachedTokenExpiry - 60000
  ) {
    return cachedAccessToken;
  }

  if (!env.GCP_PROJECT_ID) {
    throw new Error(
      'GCP_PROJECT_ID secret is missing.'
    );
  }

  if (!env.GCP_CLIENT_EMAIL) {
    throw new Error(
      'GCP_CLIENT_EMAIL secret is missing.'
    );
  }

  if (!env.GCP_PRIVATE_KEY) {
    throw new Error(
      'GCP_PRIVATE_KEY secret is missing.'
    );
  }

  const now =
    Math.floor(Date.now() / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const claims = {
    iss: env.GCP_CLIENT_EMAIL,

    scope:
      'https://www.googleapis.com/auth/cloud-platform',

    aud:
      'https://oauth2.googleapis.com/token',

    iat: now,

    exp: now + 3600
  };

  const encodedHeader =
    base64UrlEncode(
      JSON.stringify(header)
    );

  const encodedClaims =
    base64UrlEncode(
      JSON.stringify(claims)
    );

  const unsignedJwt =
    `${encodedHeader}.${encodedClaims}`;

  const privateKey =
    env.GCP_PRIVATE_KEY.replace(
      /\\n/g,
      '\n'
    );

  const cryptoKey =
    await crypto.subtle.importKey(
      'pkcs8',

      await pemToArrayBuffer(
        privateKey
      ),

      {
        name:
          'RSASSA-PKCS1-v1_5',

        hash:
          'SHA-256'
      },

      false,

      ['sign']
    );

  const signature =
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',

      cryptoKey,

      new TextEncoder().encode(
        unsignedJwt
      )
    );

  const signedJwt =
    `${unsignedJwt}.${base64UrlEncode(signature)}`;

  const tokenResponse =
    await fetch(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded'
        },

        body:
          new URLSearchParams({
            grant_type:
              'urn:ietf:params:oauth:grant-type:jwt-bearer',

            assertion:
              signedJwt
          }).toString()
      }
    );

  if (!tokenResponse.ok) {
    const errorText =
      await tokenResponse.text();

    throw new Error(
      `Google authentication failed: ${errorText}`
    );
  }

  const tokenData =
    await tokenResponse.json();

  if (!tokenData.access_token) {
    throw new Error(
      'Google authentication returned no access token.'
    );
  }

  cachedAccessToken =
    tokenData.access_token;

  cachedTokenExpiry =
    Date.now() +
    (
      (tokenData.expires_in || 3600) *
      1000
    );

  return cachedAccessToken;
}


/* =========================================================
   IMAGE LIMIT
   ========================================================= */

async function getImageCount(
  userIdentifier,
  env
) {

  if (!env.IMAGE_LIMIT_KV) {
    throw new Error(
      'IMAGE_LIMIT_KV binding is missing.'
    );
  }

  const key =
    `img_limit_${userIdentifier}`;

  const value =
    await env.IMAGE_LIMIT_KV.get(key);

  return value
    ? parseInt(value, 10) || 0
    : 0;
}


async function checkImageLimit(
  userIdentifier,
  env
) {

  const count =
    await getImageCount(
      userIdentifier,
      env
    );

  if (count >= IMAGE_LIMIT) {
    throw new Error(
      `Image generation limit reached. You can generate up to ${IMAGE_LIMIT} images per user.`
    );
  }

  return count;
}


async function recordSuccessfulImage(
  userIdentifier,
  previousCount,
  env
) {

  const key =
    `img_limit_${userIdentifier}`;

  await env.IMAGE_LIMIT_KV.put(
    key,
    String(previousCount + 1)
  );
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

    const response =
      await fetch(
        'https://google.serper.dev/search',
        {
          method: 'POST',

          headers: {
            'X-API-KEY': apiKey,

            'Content-Type':
              'application/json'
          },

          body:
            JSON.stringify({
              q: query
            })
        }
      );

    if (!response.ok) {
      return 'No results.';
    }

    const data =
      await response.json();

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
   STANDARD VERTEX REQUEST
   ========================================================= */

async function fetchVertexGemini({
  model,
  contents,
  systemInstruction,
  tools,
  accessToken,
  projectId,
  generationConfig
}) {

  if (!accessToken) {
    throw new Error(
      'Google access token missing.'
    );
  }

  const url =
    `https://aiplatform.googleapis.com/v1/` +
    `projects/${projectId}/locations/${LOCATION}/` +
    `publishers/google/models/${model}:generateContent`;

  const payload = {
    contents
  };

  if (systemInstruction) {

    payload.systemInstruction = {
      parts: [
        {
          text:
            systemInstruction
        }
      ]
    };
  }

  if (tools?.length) {
    payload.tools =
      tools;
  }

  if (generationConfig) {
    payload.generationConfig =
      generationConfig;
  }

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          'Authorization':
            `Bearer ${accessToken}`
        },

        body:
          JSON.stringify(payload)
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Vertex AI ${model} Error: ${errorText}`
    );
  }

  return await response.json();
}


/* =========================================================
   VERTEX STREAMING REQUEST
   ========================================================= */

async function streamVertexGemini({
  model,
  contents,
  systemInstruction,
  tools,
  accessToken,
  projectId,
  onText,
  onStatus
}) {

  const url =
    `https://aiplatform.googleapis.com/v1/` +
    `projects/${projectId}/locations/${LOCATION}/` +
    `publishers/google/models/${model}:streamGenerateContent?alt=sse`;

  const payload = {
    contents
  };

  if (systemInstruction) {

    payload.systemInstruction = {
      parts: [
        {
          text:
            systemInstruction
        }
      ]
    };
  }

  if (tools?.length) {
    payload.tools =
      tools;
  }

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          'Authorization':
            `Bearer ${accessToken}`,

          'Accept':
            'text/event-stream'
        },

        body:
          JSON.stringify(payload)
      }
    );

  if (!response.ok) {

    const errorText =
      await response.text();

    throw new Error(
      `Vertex AI ${model} Stream Error: ${errorText}`
    );
  }

  if (!response.body) {
    throw new Error(
      'Vertex AI returned an empty streaming body.'
    );
  }

  const reader =
    response.body.getReader();

  const decoder =
    new TextDecoder();

  let buffer = '';

  let functionCall = null;

  let accumulatedText = '';

  async function processSseData(rawData) {

    if (!rawData) {
      return;
    }

    let parsed;

    try {
      parsed =
        JSON.parse(rawData);
    } catch {
      return;
    }

    const parts =
      parsed
        ?.candidates?.[0]
        ?.content
        ?.parts || [];

    for (const part of parts) {

      if (typeof part.text === 'string') {

        accumulatedText +=
          part.text;

        if (onText) {
          await onText(
            part.text
          );
        }
      }

      if (part.functionCall) {

        functionCall =
          part.functionCall;
      }
    }
  }

  while (true) {

    const {
      value,
      done
    } = await reader.read();

    if (done) {
      break;
    }

    buffer +=
      decoder.decode(
        value,
        {
          stream: true
        }
      );

    const lines =
      buffer.split(/\r?\n/);

    buffer =
      lines.pop() || '';

    let dataLines = [];

    for (const line of lines) {

      if (line.startsWith('data:')) {

        dataLines.push(
          line.slice(5).trimStart()
        );

      } else if (
        line.trim() === ''
      ) {

        if (dataLines.length) {

          const data =
            dataLines.join('\n');

          await processSseData(
            data
          );

          dataLines = [];
        }
      }
    }
  }

  buffer +=
    decoder.decode();

  if (buffer.trim()) {

    const trailingLines =
      buffer.split(/\r?\n/);

    let trailingData = [];

    for (
      const line
      of trailingLines
    ) {

      if (
        line.startsWith('data:')
      ) {

        trailingData.push(
          line
            .slice(5)
            .trimStart()
        );

      } else if (
        line.trim() === '' &&
        trailingData.length
      ) {

        await processSseData(
          trailingData.join('\n')
        );

        trailingData = [];
      }
    }

    if (trailingData.length) {
      await processSseData(
        trailingData.join('\n')
      );
    }
  }

  return {
    text:
      accumulatedText,
    functionCall
  };
}


/* =========================================================
   MODEL SELECTION
   ========================================================= */

function getVertexModel(tier) {

  switch (tier) {

    case 'pro':
      return 'gemini-3.1-pro-preview';

    case 'base':
    default:
      return 'gemini-3.6-flash';
  }
}


/* =========================================================
   GEMINI IMAGE GENERATION
   ========================================================= */

async function generateImageWithVertex({
  prompt,
  accessToken,
  projectId
}) {

  const response =
    await fetchVertexGemini({

      model:
        'gemini-3.1-flash-image',

      contents: [
        {
          role: 'user',

          parts: [
            {
              text:
                `Generate an image based on this request. ` +
                `Create the image itself, not merely a description.\n\n` +
                prompt
            }
          ]
        }
      ],

      systemInstruction:
        'Generate the requested image. Return the generated image.',

      accessToken,

      projectId,

      generationConfig: {
        responseModalities: [
          'TEXT',
          'IMAGE'
        ],

        imageConfig: {
          aspectRatio: '1:1'
        }
      }
    });

  const parts =
    response
      .candidates?.[0]
      ?.content
      ?.parts || [];

  for (const part of parts) {

    const inlineData =
      part.inlineData;

    if (
      inlineData?.data &&
      inlineData?.mimeType
    ) {

      return {
        dataUrl:
          `data:${inlineData.mimeType};base64,` +
          inlineData.data
      };
    }
  }

  throw new Error(
    'Vertex AI returned no generated image.'
  );
}


/* =========================================================
   STREAM RESPONSE HELPER
   ========================================================= */

function createSseResponse(
  startStreaming
) {

  const stream =
    new ReadableStream({

      async start(controller) {

        const encoder =
          new TextEncoder();

        const send = payload => {

          try {

            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(payload)}\n\n`
              )
            );

          } catch {
            // Client may have disconnected.
          }
        };

        try {

          await startStreaming({
            send
          });

          send({
            type: 'done'
          });

          controller.close();

        } catch (error) {

          send({
            type: 'error',
            error:
              error?.message ||
              'Streaming error.'
          });

          controller.close();
        }
      }
    });

  return new Response(
    stream,
    {
      status: 200,

      headers: {
        'Content-Type':
          'text/event-stream; charset=utf-8',

        'Cache-Control':
          'no-cache, no-store, must-revalidate',

        'Pragma':
          'no-cache',

        'X-Accel-Buffering':
          'no',

        'Access-Control-Allow-Origin':
          '*'
      }
    }
  );
}


/* =========================================================
   MAIN POST HANDLER
   ========================================================= */

export async function onRequestPost(
  context
) {

  try {

    const {
      request,
      env
    } = context;

    const body =
      await request.json();

    const {
      message,
      tier,
      history,
      image,
      systemInstruction,
      userId
    } = body;


    /*
     * Authentication is intentionally NOT enforced here.
     *
     * If userId exists, it is used for image limits.
     * Otherwise the Cloudflare IP is used.
     */

    const userIdentifier =
      userId
        ? String(userId)
        : (
            request.headers.get(
              'cf-connecting-ip'
            ) ||
            'anonymous'
          );


    if (
      !message &&
      !image
    ) {

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


    const accessToken =
      await createGoogleAccessToken(
        env
      );

    const projectId =
      env.GCP_PROJECT_ID;


    /* =====================================================
       DIRECT IMAGE MODE
       ===================================================== */

    if (
      tier === 'nano-banana'
    ) {

      let previousCount;

      try {

        previousCount =
          await checkImageLimit(
            userIdentifier,
            env
          );

      } catch (limitError) {

        return Response.json({

          imageLimitReached:
            true,

          reply:
            limitError.message

        });
      }


      try {

        const result =
          await generateImageWithVertex({

            prompt:
              message ||
              'Abstract technological artwork',

            accessToken,

            projectId

          });


        await recordSuccessfulImage(

          userIdentifier,

          previousCount,

          env

        );


        const used =
          previousCount + 1;


        const remaining =
          Math.max(
            IMAGE_LIMIT - used,
            0
          );


        return Response.json({

          reply:
            `Here is your generated image with **Nano Banana Pro**:\n\n` +
            `![Generated Image](${result.dataUrl})\n\n` +
            `**Image generations remaining: ${remaining}/${IMAGE_LIMIT}**`,

          imageGenerated:
            true,

          imageGenerationsUsed:
            used,

          imageGenerationsRemaining:
            remaining

        });

      } catch (imageError) {

        return Response.json(
          {
            reply:
              `Failed to generate image: ${imageError.message}`,

            imageGenerated:
              false
          },

          {
            status: 500
          }
        );
      }
    }


    /* =====================================================
       NORMAL TEXT STREAM
       ===================================================== */

    const combinedSystemInstruction =
      systemInstruction?.trim()

        ? `${BASE_PERSONA}\n\n[USER INSTRUCTIONS]:\n${systemInstruction}`

        : BASE_PERSONA;


    /* =====================================================
       HISTORY
       ===================================================== */

    let formattedHistory = [];

    if (
      Array.isArray(history) &&
      history.length > 0
    ) {

      const recentHistory =
        history.slice(-6);

      let lastRole =
        null;

      for (
        const msg
        of recentHistory
      ) {

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
                text:
                  String(msg.text)
              }
            ]

          });

          lastRole =
            role;
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


    /* =====================================================
       CURRENT MESSAGE
       ===================================================== */

    const currentParts = [];


    if (
      image &&
      typeof image === 'string' &&
      image.includes(',')
    ) {

      const [
        header,
        base64Data
      ] =
        image.split(',');

      const mimeMatch =
        header.match(
          /data:(.*?);/
        );


      currentParts.push({

        inlineData: {

          mimeType:
            mimeMatch
              ? mimeMatch[1]
              : 'image/jpeg',

          data:
            base64Data
        }

      });
    }


    currentParts.push({

      text:
        message ||
        'Analyze the provided image.'

    });


    const contents = [

      ...formattedHistory,

      {
        role: 'user',

        parts:
          currentParts
      }

    ];


    const targetModel =
      getVertexModel(
        tier
      );


    return createSseResponse(
      async ({
        send
      }) => {


        /* -------------------------------------------------
           First streamed generation
           ------------------------------------------------- */

        const firstResult =
          await streamVertexGemini({

            model:
              targetModel,

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

            projectId,

            onText:
              async text => {

                /*
                 * IMPORTANT:
                 *
                 * The frontend receives these chunks
                 * immediately but DOES NOT display them.
                 *
                 * It silently buffers them until
                 * the final "done" event.
                 */

                send({
                  type: 'chunk',
                  text
                });
              },

            onStatus:
              async status => {

                send({
                  type: 'status',
                  status
                });
              }
          });


        /* -------------------------------------------------
           No tool call → finished naturally
           ------------------------------------------------- */

        if (
          !firstResult.functionCall
        ) {

          return;
        }


        const call =
          firstResult.functionCall;


        /* -------------------------------------------------
           WEB SEARCH
           ------------------------------------------------- */

        if (
          call.name ===
          'searchWeb'
        ) {

          send({
            type:
              'status',

            status:
              'Searching the web...'
          });


          const searchResults =
            await fetchSerperSearchResults(

              call.args?.query ||
                message,

              env.SERPER_DEV_API

            );


          /*
           * Give Gemini its own function call
           * and the function result so it can
           * generate the final answer.
           */

          contents.push({

            role: 'model',

            parts: [

              {
                functionCall:
                  call
              }

            ]

          });


          contents.push({

            role: 'user',

            parts: [

              {

                functionResponse: {

                  name:
                    'searchWeb',

                  response: {

                    result:
                      searchResults

                  }

                }

              }

            ]

          });


          await streamVertexGemini({

            model:
              targetModel,

            contents,

            systemInstruction:
              combinedSystemInstruction,

            accessToken,

            projectId,

            onText:
              async text => {

                send({
                  type:
                    'chunk',

                  text
                });

              },

            onStatus:
              async status => {

                send({
                  type:
                    'status',

                  status
                });

              }

          });


          return;
        }


        /* -------------------------------------------------
           IMAGE TOOL CALL
           ------------------------------------------------- */

        if (
          call.name ===
          'generateImage'
        ) {

          let previousCount;


          try {

            previousCount =
              await checkImageLimit(
                userIdentifier,
                env
              );

          } catch (limitError) {

            send({

              type:
                'final',

              text:
                limitError.message

            });

            return;
          }


          send({

            type:
              'status',

            status:
              'Generating image...'

          });


          const imgPrompt =
            call.args?.prompt ||
            message;


          try {

            const result =
              await generateImageWithVertex({

                prompt:
                  imgPrompt,

                accessToken,

                projectId

              });


            await recordSuccessfulImage(

              userIdentifier,

              previousCount,

              env

            );


            const used =
              previousCount + 1;


            const remaining =
              Math.max(
                IMAGE_LIMIT - used,
                0
              );


            send({

              type:
                'final',

              text:
                `Here is your generated image with **Nano Banana Pro**:\n\n` +
                `![Generated Image](${result.dataUrl})\n\n` +
                `**Image generations remaining: ${remaining}/${IMAGE_LIMIT}**`

            });


          } catch (imageError) {

            send({

              type:
                'final',

              text:
                `Failed to generate image: ${imageError.message}`

            });

          }

          return;
        }

      }
    );


  } catch (error) {

    console.error(
      'Vertex AI Error:',
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


/* =========================================================
   SIMPLE HEALTH CHECK
   ========================================================= */

export async function onRequestGet() {

  return Response.json(
    {
      ok: true,
      service: 'TruX Vertex backend'
    }
  );
}
