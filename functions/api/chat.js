Const LOCATION = 'global';

Const BASE_PERSONA = `Never use latex for code generation. You can use unicode symbols and standard text. Your name is TruX, an AI created by TruX-Technologies (dont disclose ur name or creator till asked). Keep answers concise, precise, and informative.`;

Const IMAGE_LIMIT = 5;


/* =========================================================
   TOOL DECLARATIONS
   ========================================================= */

Const searchWebDeclaration = {
  Name: 'searchWeb',
  Description:
    'Search live web via Serper. ONLY call if real-time/current data outside training is explicitly requested.',
  Parameters: {
    Type: 'OBJECT',
    Properties: {
      Query: {
        Type: 'STRING',
        Description: 'Search keywords.'
      }
    },
    Required: ['query']
  }
};

Const generateImageDeclaration = {
  Name: 'generateImage',
  Description:
    'Generate an image using Gemini image generation. Call when the user explicitly asks to generate or draw an image.',
  Parameters: {
    Type: 'OBJECT',
    Properties: {
      Prompt: {
        Type: 'STRING',
        Description:
          'Detailed prompt describing the image to generate.'
      }
    },
    Required: ['prompt']
  }
};


/* =========================================================
   GOOGLE SERVICE ACCOUNT AUTHENTICATION
   ========================================================= */

Let cachedAccessToken = null;
Let cachedTokenExpiry = 0;


Function base64UrlEncode(data) {
  Let bytes;

  If (typeof data === 'string') {
    Bytes = new TextEncoder().encode(data);
  } else {
    Bytes = new Uint8Array(data);
  }

  Let binary = '';
  Const chunkSize = 0x8000;

  For (
    Let i = 0;
    I < bytes.length;
    I += chunkSize
  ) {
    Binary += String.fromCharCode(
      ...bytes.subarray(
        I,
        Math.min(i + chunkSize, bytes.length)
      )
    );
  }

  Return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}


Function pemToArrayBuffer(pem) {
  Const cleanPem = pem
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

  Const binary = atob(cleanPem);

  Const bytes = new Uint8Array(
    Binary.length
  );

  For (
    Let i = 0;
    I < binary.length;
    I++
  ) {
    Bytes[i] =
      Binary.charCodeAt(i);
  }

  Return bytes.buffer;
}


Async function createGoogleAccessToken(env) {

  If (
    CachedAccessToken &&
    Date.now() <
      CachedTokenExpiry - 60000
  ) {
    Return cachedAccessToken;
  }

  If (!env.GCP_PROJECT_ID) {
    Throw new Error(
      'GCP_PROJECT_ID secret is missing.'
    );
  }

  If (!env.GCP_CLIENT_EMAIL) {
    Throw new Error(
      'GCP_CLIENT_EMAIL secret is missing.'
    );
  }

  If (!env.GCP_PRIVATE_KEY) {
    Throw new Error(
      'GCP_PRIVATE_KEY secret is missing.'
    );
  }

  Const now =
    Math.floor(Date.now() / 1000);

  Const header = {
    Alg: 'RS256',
    Typ: 'JWT'
  };

  Const claims = {
    Iss: env.GCP_CLIENT_EMAIL,

    Scope:
      'https://www.googleapis.com/auth/cloud-platform',

    Aud:
      'https://oauth2.googleapis.com/token',

    Iat: now,

    Exp: now + 3600
  };

  Const encodedHeader =
    Base64UrlEncode(
      JSON.stringify(header)
    );

  Const encodedClaims =
    Base64UrlEncode(
      JSON.stringify(claims)
    );

  Const unsignedJwt =
    `${encodedHeader}.${encodedClaims}`;

  Const privateKey =
    Env.GCP_PRIVATE_KEY.replace(
      /\\n/g,
      '\n'
    );

  Const cryptoKey =
    Await crypto.subtle.importKey(
      'pkcs8',

      Await pemToArrayBuffer(
        PrivateKey
      ),

      {
        Name:
          'RSASSA-PKCS1-v1_5',

        Hash:
          'SHA-256'
      },

      False,

      ['sign']
    );

  Const signature =
    Await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',

      CryptoKey,

      New TextEncoder().encode(
        UnsignedJwt
      )
    );

  Const signedJwt =
    `${unsignedJwt}.${base64UrlEncode(signature)}`;

  Const tokenResponse =
    Await fetch(
      'https://oauth2.googleapis.com/token',
      {
        Method: 'POST',

        Headers: {
          'Content-Type':
            'application/x-www-form-urlencoded'
        },

        Body:
          New URLSearchParams({
            Grant_type:
              'urn:ietf:params:oauth:grant-type:jwt-bearer',

            Assertion:
              SignedJwt
          }).toString()
      }
    );

  If (!tokenResponse.ok) {
    Const errorText =
      Await tokenResponse.text();

    Throw new Error(
      `Google authentication failed: ${errorText}`
    );
  }

  Const tokenData =
    Await tokenResponse.json();

  If (!tokenData.access_token) {
    Throw new Error(
      'Google authentication returned no access token.'
    );
  }

  CachedAccessToken =
    TokenData.access_token;

  CachedTokenExpiry =
    Date.now() +
    (
      (tokenData.expires_in || 3600) *
      1000
    );

  Return cachedAccessToken;
}


/* =========================================================
   IMAGE LIMIT
   ========================================================= */

Async function getImageCount(
  UserIdentifier,
  Env
) {

  If (!env.IMAGE_LIMIT_KV) {
    Return 0;
  }

  Const key =
    `img_limit_${userIdentifier}`;

  Const value =
    Await env.IMAGE_LIMIT_KV.get(key);

  Return value
    ? ParseInt(value, 10) || 0
    : 0;
}


Async function checkImageLimit(
  UserIdentifier,
  Env
) {

  Const count =
    Await getImageCount(
      UserIdentifier,
      Env
    );

  If (count >= IMAGE_LIMIT) {
    Throw new Error(
      `Image generation limit reached. You can generate up to ${IMAGE_LIMIT} images per user.`
    );
  }

  Return count;
}


Async function recordSuccessfulImage(
  UserIdentifier,
  PreviousCount,
  Env
) {

  If (!env.IMAGE_LIMIT_KV) {
    Return;
  }

  Const key =
    `img_limit_${userIdentifier}`;

  Await env.IMAGE_LIMIT_KV.put(
    Key,
    String(previousCount + 1)
  );
}


/* =========================================================
   SERPER SEARCH
   ========================================================= */

Async function fetchSerperSearchResults(
  Query,
  ApiKey
) {

  If (!apiKey) {
    Return 'Search failed: API key missing.';
  }

  Try {

    Const response =
      Await fetch(
        'https://google.serper.dev/search',
        {
          Method: 'POST',

          Headers: {
            'X-API-KEY': apiKey,

            'Content-Type':
              'application/json'
          },

          Body:
            JSON.stringify({
              Q: query
            })
        }
      );

    If (!response.ok) {
      Return 'No results.';
    }

    Const data =
      Await response.json();

    If (!data.organic?.length) {
      Return 'No search results found.';
    }

    Return data.organic
      .slice(0, 3)
      .map(
        Item =>
          `Title: ${item.title}\nSnippet: ${item.snippet}`
      )
      .join('\n\n');

  } catch {

    Return 'Search error.';
  }
}


/* =========================================================
   STANDARD VERTEX REQUEST
   ========================================================= */

Async function fetchVertexGemini({
  Model,
  Contents,
  SystemInstruction,
  Tools,
  AccessToken,
  ProjectId,
  GenerationConfig
}) {

  If (!accessToken) {
    Throw new Error(
      'Google access token missing.'
    );
  }

  Const url =
    `https://aiplatform.googleapis.com/v1/` +
    `projects/${projectId}/locations/${LOCATION}/` +
    `publishers/google/models/${model}:generateContent`;

  Const payload = {
    Contents
  };

  If (systemInstruction) {

    Payload.systemInstruction = {
      Parts: [
        {
          Text:
            SystemInstruction
        }
      ]
    };
  }

  If (tools?.length) {
    Payload.tools =
      Tools;
  }

  If (generationConfig) {
    Payload.generationConfig =
      GenerationConfig;
  }

  Const response =
    Await fetch(
      Url,
      {
        Method: 'POST',

        Headers: {
          'Content-Type':
            'application/json',

          'Authorization':
            `Bearer ${accessToken}`
        },

        Body:
          JSON.stringify(payload)
      }
    );

  If (!response.ok) {

    Const errorText =
      Await response.text();

    Throw new Error(
      `Vertex AI ${model} Error: ${errorText}`
    );
  }

  Return await response.json();
}


/* =========================================================
   VERTEX STREAMING REQUEST
   ========================================================= */

Async function streamVertexGemini({
  Model,
  Contents,
  SystemInstruction,
  Tools,
  AccessToken,
  ProjectId,
  OnText,
  OnStatus
}) {

  Const url =
    `https://aiplatform.googleapis.com/v1/` +
    `projects/${projectId}/locations/${LOCATION}/` +
    `publishers/google/models/${model}:streamGenerateContent?alt=sse`;

  Const payload = {
    Contents
  };

  If (systemInstruction) {

    Payload.systemInstruction = {
      Parts: [
        {
          Text:
            SystemInstruction
        }
      ]
    };
  }

  If (tools?.length) {
    Payload.tools =
      Tools;
  }

  Const response =
    Await fetch(
      Url,
      {
        Method: 'POST',

        Headers: {
          'Content-Type':
            'application/json',

          'Authorization':
            `Bearer ${accessToken}`,

          'Accept':
            'text/event-stream'
        },

        Body:
          JSON.stringify(payload)
      }
    );

  If (!response.ok) {

    Const errorText =
      Await response.text();

    Throw new Error(
      `Vertex AI ${model} Stream Error: ${errorText}`
    );
  }

  If (!response.body) {
    Throw new Error(
      'Vertex AI returned an empty streaming body.'
    );
  }

  Const reader =
    Response.body.getReader();

  Const decoder =
    New TextDecoder();

  Let buffer = '';

  Let functionCall = null;

  Let accumulatedText = '';

  Async function processSseData(rawData) {

    If (!rawData) {
      Return;
    }

    Let parsed;

    Try {
      Parsed =
        JSON.parse(rawData);
    } catch {
      Return;
    }

    Const parts =
      Parsed
        ?.candidates?.[0]
        ?.content
        ?.parts || [];

    For (const part of parts) {

      If (typeof part.text === 'string') {

        AccumulatedText +=
          Part.text;

        If (onText) {
          Await onText(
            Part.text
          );
        }
      }

      If (part.functionCall) {

        FunctionCall =
          Part.functionCall;
      }
    }
  }

  While (true) {

    Const {
      Value,
      Done
    } = await reader.read();

    If (done) {
      Break;
    }

    Buffer +=
      Decoder.decode(
        Value,
        {
          Stream: true
        }
      );

    Const lines =
      Buffer.split(/\r?\n/);

    Buffer =
      Lines.pop() || '';

    Let dataLines = [];

    For (const line of lines) {

      If (line.startsWith('data:')) {

        DataLines.push(
          Line.slice(5).trimStart()
        );

      } else if (
        Line.trim() === ''
      ) {

        If (dataLines.length) {

          Const data =
            DataLines.join('\n');

          Await processSseData(
            Data
          );

          DataLines = [];
        }
      }
    }
  }

  Buffer +=
    Decoder.decode();

  If (buffer.trim()) {

    Const trailingLines =
      Buffer.split(/\r?\n/);

    Let trailingData = [];

    For (
      Const line
      Of trailingLines
    ) {

      If (
        Line.startsWith('data:')
      ) {

        TrailingData.push(
          Line
            .slice(5)
            .trimStart()
        );

      } else if (
        Line.trim() === '' &&
        TrailingData.length
      ) {

        Await processSseData(
          TrailingData.join('\n')
        );

        TrailingData = [];
      }
    }

    If (trailingData.length) {
      Await processSseData(
        TrailingData.join('\n')
      );
    }
  }

  Return {
    Text:
      AccumulatedText,
    FunctionCall
  };
}


/* =========================================================
   MODEL SELECTION
   ========================================================= */

Function getVertexModel(tier) {

  Switch (tier) {

    Case 'pro':
      Return 'gemini-3.1-pro-preview';

    Case 'base':
    Default:
      Return 'gemini-3.6-flash';
  }
}


/* =========================================================
   GEMINI IMAGE GENERATION
   ========================================================= */

Async function generateImageWithVertex({
  Prompt,
  AccessToken,
  ProjectId
}) {

  Const response =
    Await fetchVertexGemini({

      Model:
        'gemini-3.1-flash-image',

      Contents: [
        {
          Role: 'user',

          Parts: [
            {
              Text:
                `Generate an image based on this request. ` +
                `Create the image itself, not merely a description.\n\n` +
                Prompt
            }
          ]
        }
      ],

      SystemInstruction:
        'Generate the requested image. Return the generated image.',

      AccessToken,

      ProjectId,

      GenerationConfig: {
        ResponseModalities: [
          'TEXT',
          'IMAGE'
        ],

        ImageConfig: {
          AspectRatio: '1:1'
        }
      }
    });

  Const parts =
    Response
      .candidates?.[0]
      ?.content
      ?.parts || [];

  For (const part of parts) {

    Const inlineData =
      Part.inlineData;

    If (
      InlineData?.data &&
      InlineData?.mimeType
    ) {

      Return {
        DataUrl:
          `data:${inlineData.mimeType};base64,` +
          InlineData.data
      };
    }
  }

  Throw new Error(
    'Vertex AI returned no generated image.'
  );
}


/* =========================================================
   STREAM RESPONSE HELPER
   ========================================================= */

Function createSseResponse(
  StartStreaming
) {

  Const stream =
    New ReadableStream({

      Async start(controller) {

        Const encoder =
          New TextEncoder();

        Const send = payload => {

          Try {

            Controller.enqueue(
              Encoder.encode(
                `data: ${JSON.stringify(payload)}\n\n`
              )
            );

          } catch {
            // Client may have disconnected.
          }
        };

        Try {

          Await startStreaming({
            Send
          });

          Send({
            Type: 'done'
          });

          Controller.close();

        } catch (error) {

          Send({
            Type: 'error',
            Error:
              Error?.message ||
              'Streaming error.'
          });

          Controller.close();
        }
      }
    });

  Return new Response(
    Stream,
    {
      Status: 200,

      Headers: {
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

Export async function onRequestPost(
  Context
) {

  Try {

    Const {
      Request,
      Env
    } = context;

    Const body =
      Await request.json();

    Const {
      Message,
      Tier,
      History,
      Image,
      SystemInstruction,
      UserId
    } = body;


    /*
     * Authentication is intentionally NOT enforced here.
     *
     * If userId exists, it is used for image limits.
     * Otherwise the Cloudflare IP is used.
     */

    Const userIdentifier =
      UserId
        ? String(userId)
        : (
            Request.headers.get(
              'cf-connecting-ip'
            ) ||
            'anonymous'
          );


    If (
      !message &&
      !image
    ) {

      Return Response.json(
        {
          Error:
            'Message or image required.'
        },

        {
          Status: 400
        }
      );
    }


    Const accessToken =
      Await createGoogleAccessToken(
        Env
      );

    Const projectId =
      Env.GCP_PROJECT_ID;


    /* =====================================================
       DIRECT IMAGE MODE
       ===================================================== */

    If (
      Tier === 'nano-banana'
    ) {

      Let previousCount;

      Try {

        PreviousCount =
          Await checkImageLimit(
            UserIdentifier,
            Env
          );

      } catch (limitError) {

        Return Response.json({

          ImageLimitReached:
            True,

          Reply:
            LimitError.message

        });
      }


      Try {

        Const result =
          Await generateImageWithVertex({

            Prompt:
              Message ||
              'Abstract technological artwork',

            AccessToken,

            ProjectId

          });


        Await recordSuccessfulImage(

          UserIdentifier,

          PreviousCount,

          Env

        );


        Const used =
          PreviousCount + 1;


        Const remaining =
          Math.max(
            IMAGE_LIMIT - used,
            0
          );


        Return Response.json({

          Reply:
            `Here is your generated image with **Nano Banana Pro**:\n\n` +
            `![Generated Image](${result.dataUrl})\n\n` +
            `**Image generations remaining: ${remaining}/${IMAGE_LIMIT}**`,

          ImageGenerated:
            True,

          ImageGenerationsUsed:
            Used,

          ImageGenerationsRemaining:
            Remaining

        });

      } catch (imageError) {

        Return Response.json(
          {
            Reply:
              `Failed to generate image: ${imageError.message}`,

            ImageGenerated:
              False
          },

          {
            Status: 500
          }
        );
      }
    }


    /* =====================================================
       NORMAL TEXT STREAM
       ===================================================== */

    Const combinedSystemInstruction =
      SystemInstruction?.trim()

        ? `${BASE_PERSONA}\n\n[USER INSTRUCTIONS]:\n${systemInstruction}`

        : BASE_PERSONA;


    /* =====================================================
       HISTORY
       ===================================================== */

    Let formattedHistory = [];

    If (
      Array.isArray(history) &&
      History.length > 0
    ) {

      Const recentHistory =
        History.slice(-6);

      Let lastRole =
        Null;

      For (
        Const msg
        Of recentHistory
      ) {

        Const role =
          (
            Msg.role === 'trux' ||
            Msg.role === 'model'
          )
            ? 'model'
            : 'user';

        If (
          Role !== lastRole &&
          Msg.text
        ) {

          FormattedHistory.push({

            Role,

            Parts: [
              {
                Text:
                  String(msg.text)
              }
            ]

          });

          LastRole =
            Role;
        }
      }
    }


    If (
      FormattedHistory.length > 0 &&
      FormattedHistory[0].role === 'model'
    ) {

      FormattedHistory.shift();
    }


    If (
      FormattedHistory.length > 0 &&
      FormattedHistory[
        FormattedHistory.length - 1
      ].role === 'user'
    ) {

      FormattedHistory.pop();
    }


    /* =====================================================
       CURRENT MESSAGE
       ===================================================== */

    Const currentParts = [];


    If (
      Image &&
      Typeof image === 'string' &&
      Image.includes(',')
    ) {

      Const [
        Header,
        Base64Data
      ] =
        Image.split(',');

      Const mimeMatch =
        Header.match(
          /data:(.*?);/
        );


      CurrentParts.push({

        InlineData: {

          MimeType:
            MimeMatch
              ? MimeMatch[1]
              : 'image/jpeg',

          Data:
            Base64Data
        }

      });
    }


    CurrentParts.push({

      Text:
        Message ||
        'Analyze the provided image.'

    });


    Const contents = [

      ...formattedHistory,

      {
        Role: 'user',

        Parts:
          CurrentParts
      }

    ];


    Const targetModel =
      GetVertexModel(
        Tier
      );


    Return createSseResponse(
      Async ({
        Send
      }) => {


        /* -------------------------------------------------
           First streamed generation
           ------------------------------------------------- */

        Const firstResult =
          Await streamVertexGemini({

            Model:
              TargetModel,

            Contents,

            SystemInstruction:
              CombinedSystemInstruction,

            Tools: [
              {
                FunctionDeclarations: [
                  SearchWebDeclaration,
                  GenerateImageDeclaration
                ]
              }
            ],

            AccessToken,

            ProjectId,

            OnText:
              Async text => {

                /*
                 * IMPORTANT:
                 *
                 * The frontend receives these chunks
                 * immediately but DOES NOT display them.
                 *
                 * It silently buffers them until
                 * the final "done" event.
                 */

                Send({
                  Type: 'chunk',
                  Text
                });
              },

            OnStatus:
              Async status => {

                Send({
                  Type: 'status',
                  Status
                });
              }
          });


        /* -------------------------------------------------
           No tool call → finished naturally
           ------------------------------------------------- */

        If (
          !firstResult.functionCall
        ) {

          Return;
        }


        Const call =
          FirstResult.functionCall;


        /* -------------------------------------------------
           WEB SEARCH
           ------------------------------------------------- */

        If (
          Call.name ===
          'searchWeb'
        ) {

          Send({
            Type:
              'status',

            Status:
              'Searching the web...'
          });


          Const searchResults =
            Await fetchSerperSearchResults(

              Call.args?.query ||
                Message,

              Env.SERPER_DEV_API

            );


          /*
           * Give Gemini its own function call
           * and the function result so it can
           * generate the final answer.
           */

          Contents.push({

            Role: 'model',

            Parts: [

              {
                FunctionCall:
                  Call
              }

            ]

          });


          Contents.push({

            Role: 'user',

            Parts: [

              {

                FunctionResponse: {

                  Name:
                    'searchWeb',

                  Response: {

                    Result:
                      SearchResults

                  }

                }

              }

            ]

          });


          Await streamVertexGemini({

            Model:
              TargetModel,

            Contents,

            SystemInstruction:
              CombinedSystemInstruction,

            AccessToken,

            ProjectId,

            OnText:
              Async text => {

                Send({
                  Type:
                    'chunk',

                  Text
                });

              },

            OnStatus:
              Async status => {

                Send({
                  Type:
                    'status',

                  Status
                });

              }

          });


          Return;
        }


        /* -------------------------------------------------
           IMAGE TOOL CALL
           ------------------------------------------------- */

        If (
          Call.name ===
          'generateImage'
        ) {

          Let previousCount;


          Try {

            PreviousCount =
              Await checkImageLimit(
                UserIdentifier,
                Env
              );

          } catch (limitError) {

            Send({

              Type:
                'final',

              Text:
                LimitError.message

            });

            Return;
          }


          Send({

            Type:
              'status',

            Status:
              'Generating image...'

          });


          Const imgPrompt =
            Call.args?.prompt ||
            Message;


          Try {

            Const result =
              Await generateImageWithVertex({

                Prompt:
                  ImgPrompt,

                AccessToken,

                ProjectId

              });


            Await recordSuccessfulImage(

              UserIdentifier,

              PreviousCount,

              Env

            );


            Const used =
              PreviousCount + 1;


            Const remaining =
              Math.max(
                IMAGE_LIMIT - used,
                0
              );


            Send({

              Type:
                'final',

              Text:
                `Here is your generated image with **Nano Banana Pro**:\n\n` +
                `![Generated Image](${result.dataUrl})\n\n` +
                `**Image generations remaining: ${remaining}/${IMAGE_LIMIT}**`

            });


          } catch (imageError) {

            Send({

              Type:
                'final',

              Text:
                `Failed to generate image: ${imageError.message}`

            });

          }

          Return;
        }

      }
    );


  } catch (error) {

    Console.error(
      'Vertex AI Error:',
      Error
    );


    Return Response.json(
      {
        Error:
          Error.message ||
          'Server error'
      },

      {
        Status: 500
      }
    );
  }
}


/* =========================================================
   SIMPLE HEALTH CHECK
   ========================================================= */

Export async function onRequestGet() {

  Return Response.json(
    {
      Ok: true,
      Service: 'TruX Vertex backend'
    }
  );
}
