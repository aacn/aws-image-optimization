import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import Sharp from "sharp";
import fetch from "node-fetch";

const s3Client = new S3Client();
const S3_ORIGINAL_IMAGE_BUCKET = process.env.ORIGINAL_BUCKET_NAME;
const S3_TRANSFORMED_IMAGE_BUCKET = process.env.TRANSFORMED_BUCKET_NAME;
const TRANSFORMED_IMAGE_CACHE_TTL = process.env.S3_TRANSFORMED_IMAGE_CACHE_TTL;
const MAX_IMAGE_SIZE = parseInt(process.env.MAX_IMAGE_SIZE);
const MAX_IMAGE_DIMENSION = 4000;
const ALLOWED_REMOTE_PATTERNS = process.env.ALLOWED_REMOTE_PATTERNS;
const ALLOWED_REFERER_PATTERNS = process.env.ALLOWED_REFERER_PATTERNS;

function isValidRefererUrl(url) {
  for (let pattern of ALLOWED_REFERER_PATTERNS.split(',')) {
    if (new RegExp(pattern.trim()).test(url)) {
      return true;
    }
  }

  return false;
}

function isValidRemoteUrl(url) {
  for (let pattern of ALLOWED_REMOTE_PATTERNS.split(',')) {
    if (new RegExp(pattern.trim()).test(url)) {
      return true;
    }
  }

  return false;
}

const remoteImageHandler = async (url) => {
  if (!url && !isValidRemoteUrl(url)) {
    return null;
  }

  const response = await fetch(url);

  return {
    buffer: await response.arrayBuffer(),
    contentType: response.headers.get("content-type")
  };
}

export const handler = async (event) => {
  if (
    !event.requestContext ||
    !event.requestContext.http ||
    event.requestContext.http.method !== "GET"
  ) {
    logError(`${event.requestContext.http.method} HTTP Method not allowed`);
    return sendError(400);
  }

  if (!event.requestContext.http.path) {
    logError(`Empty request path not allowed`);
    return sendError(400);
  }

  const imagePathArray = event.requestContext.http.path.split("/");
  const operationsPrefix = imagePathArray.pop();

  // Only check for referer if resize is requested
  if (operationsPrefix !== "original") {
    const referer = event.headers.referer;

    if (!referer || !isValidRefererUrl(referer)) {
      logError(`Invalid or empty Referer header not allowed`);
      return sendError(400);
    }
  }

  console.log("Removing operations prefix:", operationsPrefix);
  console.log("Removing path component:", imagePathArray.shift());

  const originalImagePath = imagePathArray.join("/");

  let startTime = performance.now();
  let originalImageBody;
  let contentType;

  try {
    // Wrapped try to allow multi-stage fetch logic
    try {
      // Try fetching original image from S3
      const output = await s3Client.send(
        new GetObjectCommand({
          Bucket: S3_ORIGINAL_IMAGE_BUCKET,
          Key: originalImagePath,
        })
      );

      console.log(`Got response from S3 for ${originalImagePath}`);

      originalImageBody = await output.Body.transformToByteArray();
      contentType = output.ContentType;
    } catch (error) {
      // Try fetching original image from source url
      logError("Error downloading original image from S3", error);

      const url = new URL(decodeURIComponent(originalImagePath));

      console.log("Trying url", url.toString());

      const response = await remoteImageHandler(url.toString());

      if (response) {
        originalImageBody = response.buffer;
        contentType = response.contentType;
        console.log("Got", originalImageBody.byteLength, contentType)
      } else {
        throw new Error("Unsuccessful attempt to retrieve image.")
      }

    }
  } catch (error) {
    logError("Error downloading original image", error);
    return sendError(404);
  }

  let transformedImageBuffer;
  let transformedImage = Sharp(originalImageBody, {
    failOn: "none",
    animated: true,
  });
  const imageMetadata = await transformedImage.metadata();

  const operationsJSON = Object.fromEntries(
    operationsPrefix.split(",").map((operation) => operation.split("="))
  );

  let timingLog = "img-download;dur=" + parseInt(String(performance.now() - startTime));
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
    } else if (!contentType || !contentType.startsWith("image/")) {
      // If content-type is not detected and no format is specified, fall back to png
      logError("Missing content-type, falling back to PNG");
      transformedImage.toFormat("png");
      contentType = "image/png";
    }

    transformedImageBuffer = await transformedImage.toBuffer();

  } catch (error) {
    logError("Error transforming image", error);
    return sendError(500);
  }

  timingLog += ",img-transform;dur=" + parseInt(String(performance.now() - startTime));

  const imageTooBig = Buffer.byteLength(transformedImageBuffer) > MAX_IMAGE_SIZE;

  const imageStorageKey = originalImagePath;

  if (S3_TRANSFORMED_IMAGE_BUCKET) {
    startTime = performance.now();
    try {
      const putImageCommand = new PutObjectCommand({
        Body: transformedImageBuffer,
        Bucket: S3_TRANSFORMED_IMAGE_BUCKET,
        Key: `${imageStorageKey}/${operationsPrefix}`,
        ContentType: contentType,
        CacheControl: TRANSFORMED_IMAGE_CACHE_TTL,
      });
      await s3Client.send(putImageCommand);
      timingLog += ",img-upload;dur=" + parseInt(String(performance.now() - startTime));

      if (imageTooBig) {
        return {
          statusCode: 302,
          headers: {
            Location: `/${imageStorageKey}?${operationsPrefix.replace(
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
      body: transformedImageBuffer.toString("base64"),
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
  return {statusCode, body};
}

function logError(body, error) {
  console.log("APPLICATION ERROR", body ?? "");
  console.log(error ?? "");
}
