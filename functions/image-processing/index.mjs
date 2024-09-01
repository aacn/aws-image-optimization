import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import Sharp from "sharp";
import fetch from "node-fetch";

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.originalImageBucketName;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.transformedImageBucketName;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.transformedImageCacheTTL;
const MAX_IMAGE_SIZE = parseInt(process.env.maxImageSize);
const MAX_IMAGE_DIMENSION = 4000;
const VALID_REMOTES = 'https://cdn.shopify.com/s/files/**,https://shophub-default.fra1.digitaloceanspaces.com';

// async function fetchImage(url) {
//   return new Promise((resolve, reject) => {
//     const decodedUrl = new URL(decodeURIComponent(url));

//     const allowsFetch = (VALID_REMOTES ?? "")
//       .split(",")
//       .map((urlString) => {
//         try {
//           if (!urlString) {
//             throw null;
//           }

//           const urlObj = new URL(urlString);

//           return urlObj.hostname;
//         } catch {
//           return null;
//         }
//       })
//       .filter(Boolean)
//       .includes(decodedUrl.hostname);

//     if (!allowsFetch) {
//       return reject();
//     }

//     const client = decodedUrl.protocol === "https:" ? https : http;

//     client
//       .get(decodedUrl, (response) => {
//         if (response.statusCode !== 200) {
//           reject(
//             new Error(
//               `Failed to get image. Status code: ${response.statusCode}`
//             )
//           );
//           response.resume(); // Consume response data to free up memory
//           return;
//         }

//         const chunks = [];
//         response.on("data", (chunk) => {
//           chunks.push(chunk);
//         });

//         response.on("end", () => {
//           const byteArray = Buffer.concat(chunks);
//           const contentType = response.headers["content-type"];
//           resolve({ byteArray, contentType });
//         });
//       })
//       .on("error", (err) => {
//         reject(err);
//       });
//   });
// }

export const handler = async (event) => {
    if (!event.requestContext.http.path) {
        logError(`Empty request path not allowed`);
        return sendError(400);
    }

  if (
    !event.requestContext ||
    !event.requestContext.http ||
    event.requestContext.http.method !== "GET"
  ) {
    logError(`${event.requestContext.http.method} HTTP Method not allowed`);
    return sendError(400);
  }

  const imagePathArray = event.requestContext.http.path.split("/");
  const operationsPrefix = imagePathArray.pop();

  imagePathArray.shift();

  const originalImagePath = imagePathArray.join("/");

  let startTime = performance.now();
  let originalImageBody;
  let contentType;

  try {
    // Try fetching original image from S3
    const getOriginalImageCommand = new GetObjectCommand({
        Bucket: S3_ORIGINAL_IMAGE_BUCKET,
        Key: originalImagePath,
      });
      const getOriginalImageCommandOutput = await s3Client.send(
        getOriginalImageCommand
      );
      console.log(`Got response from S3 for ${originalImagePath}`);

      originalImageBody =
        await getOriginalImageCommandOutput.Body.transformToByteArray();
      contentType = getOriginalImageCommandOutput.ContentType;

    try {

    } catch {
      // Try fetching original image from source url
      logError("Error downloading original image from S3", error);

    //   const imageUrl = originalImagePath.split("/")[0];

    //   await fetchImage(imageUrl).then(({ byteArray, contentType }) => {
    //     originalImageBody = byteArray;
    //     contentType = contentType;
    //   });
    }
  } catch (error) {
    logError("Error downloading original image", error);
    return sendError(404);
  }

  let transformedImage = Sharp(originalImageBody, {
    failOn: "none",
    animated: true,
  });
  const imageMetadata = await transformedImage.metadata();
  const operationsJSON = Object.fromEntries(
    operationsPrefix.split(",").map((operation) => operation.split("="))
  );

  let timingLog = "img-download;dur=" + parseInt(performance.now() - startTime);
  startTime = performance.now();

  try {
    const resizingOptions = {};
    if (operationsJSON["width"]) {
      let opWidth = parseInt(operationsJSON["width"]);
      resizingOptions.width =
        opWidth > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION : opWidth;
    }
    if (operationsJSON["height"]) {
      let opHeight = parseInt(operationsJSON["height"]);
      resizingOptions.height =
        opHeight > MAX_IMAGE_DIMENSION ? MAX_IMAGE_DIMENSION : opHeight;
    }
    if (Object.keys(resizingOptions).length > 0) {
      transformedImage = transformedImage.resize(resizingOptions);
    }
    if (imageMetadata.orientation) {
      transformedImage = transformedImage.rotate();
    }
    if (operationsJSON["format"]) {
      let isLossy = false;
      switch (operationsJSON["format"]) {
        case "jpg":
        case "jpeg":
          contentType = "image/jpeg";
          isLossy = true;
          break;
        case "gif":
          contentType = "image/gif";
          break;
        case "webp":
          contentType = "image/webp";
          isLossy = true;
          break;
        case "png":
          contentType = "image/png";
          break;
        case "avif":
          contentType = "image/avif";
          isLossy = true;
          break;
        default:
          contentType = "image/jpeg";
          isLossy = true;
      }
      if (operationsJSON["quality"] && isLossy) {
        transformedImage = transformedImage.toFormat(operationsJSON["format"], {
          quality: parseInt(operationsJSON["quality"]),
        });
      } else {
        transformedImage = transformedImage.toFormat(operationsJSON["format"]);
      }
    } else if (contentType === "image/svg+xml") {
      contentType = "image/png";
    }
    transformedImage = await transformedImage.toBuffer();
  } catch (error) {
    logError("Error transforming image", error);
    return sendError(500);
  }
  timingLog += ",img-transform;dur=" + parseInt(performance.now() - startTime);

  const imageTooBig = Buffer.byteLength(transformedImage) > MAX_IMAGE_SIZE;

  if (S3_TRANSFORMED_IMAGE_BUCKET) {
    startTime = performance.now();
    try {
      const putImageCommand = new PutObjectCommand({
        Body: transformedImage,
        Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
        Key: `${originalImagePath}/${operationsPrefix}`,
        ContentType: contentType,
        Metadata: { "cache-control": TRANSFORMED_IMAGE_CACHE_TTL },
      });
      await s3Client.send(putImageCommand);
      timingLog += ",img-upload;dur=" + parseInt(performance.now() - startTime);

      if (imageTooBig) {
        return {
          statusCode: 302,
          headers: {
            Location: `/${originalImagePath}?${operationsPrefix.replace(
              /,/g,
              "&"
            )}`,
            "Cache-Control": "private,no-store",
            "Server-Timing": timingLog,
          },
        };
      }
    } catch (error) {
      logError("Could not upload transformed image to S3", error);
    }
  }

  if (imageTooBig) {
    logError("Requested transformed image is too big");
    return sendError(403);
  } else {
    return {
      statusCode: 200,
      body: transformedImage.toString("base64"),
      isBase64Encoded: true,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": TRANSFORMED_IMAGE_CACHE_TTL,
        "Server-Timing": timingLog,
      },
    };
  }
};

function sendError(statusCode, body, error) {
  logError(body, error);
  return { statusCode, body };
}

function logError(body, error) {
  console.log("APPLICATION ERROR", body ?? "");
  console.log(error ?? "");
}
