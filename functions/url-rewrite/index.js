const SUPPORTED_FORMATS = ['auto', 'jpeg', 'webp', 'avif', 'png', 'svg', 'gif'];

function getNormalizedFormat(request) {
    let format = 'jpeg'; // default format
    if (request.headers['accept']) {
        const acceptHeader = request.headers['accept'].value;
        if (acceptHeader.includes('avif')) {
            format = 'avif';
        } else if (acceptHeader.includes('webp')) {
            format = 'webp';
        }
    }
    return format;
}

function normalizeOperations(request) {
    let normalizedOperations = {};
    Object.keys(request.querystring).forEach(operation => {
        const value = request.querystring[operation]['value'];
        if (value) {
            switch (operation.toLowerCase()) {
                case 'format':
                    const format = value.toLowerCase();
                    if (SUPPORTED_FORMATS.includes(format)) {
                        normalizedOperations['format'] = (format === 'auto') ? getNormalizedFormat(request) : format;
                    }
                    break;
                case 'width':
                    const width = parseInt(value);
                    if (!isNaN(width) && width > 0) {
                        normalizedOperations['width'] = width.toString();
                    }
                    break;
                case 'height':
                    const height = parseInt(value);
                    if (!isNaN(height) && height > 0) {
                        normalizedOperations['height'] = height.toString();
                    }
                    break;
                case 'quality':
                    let quality = parseInt(value);
                    if (!isNaN(quality) && quality > 0) {
                        quality = Math.min(quality, 100);
                        normalizedOperations['quality'] = quality.toString();
                    }
                    break;
                default:
                    break;
            }
        }
    });
    return normalizedOperations;
}

function constructNormalizedUri(originalImagePath, normalizedOperations) {
    const normalizedOperationsArray = [];
    if (normalizedOperations.format) normalizedOperationsArray.push(`format=${normalizedOperations.format}`);
    if (normalizedOperations.quality) normalizedOperationsArray.push(`quality=${normalizedOperations.quality}`);
    if (normalizedOperations.width) normalizedOperationsArray.push(`width=${normalizedOperations.width}`);
    if (normalizedOperations.height) normalizedOperationsArray.push(`height=${normalizedOperations.height}`);
    return normalizedOperationsArray.length > 0
        ? `${originalImagePath}/${normalizedOperationsArray.join(',')}`
        : `${originalImagePath}/original`;
}

function handler(event) {
    const request = event.request;

    if (request.uri.endsWith('/')) {
        request.uri = request.uri.slice(0, -1)
    }

    const originalImagePath = request.uri;

    if (originalImagePath) {
        if (request.querystring) {
            const normalizedOperations = normalizeOperations(request);
            request.uri = constructNormalizedUri(originalImagePath, normalizedOperations);
        } else {
            request.uri = `${originalImagePath}/original`;
        }
    }

    // remove query strings
    request['querystring'] = {};
    return request;
}
