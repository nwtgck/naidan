import { validateWikipediaPrivacyFetchUrl } from './policies/wikipedia'
import type {
  PrivacyFetchValidationRejectedCode,
  PrivacyFetchValidationRejectedResult,
  PrivacyFetchValidationResult,
} from './types'

function createRejectedResult({
  code,
  message,
}: {
  code: PrivacyFetchValidationRejectedCode;
  message: string;
}): PrivacyFetchValidationRejectedResult {
  return {
    ok: false,
    code,
    message,
  }
}

export function validatePrivacyFetchUrl({
  urlText,
}: {
  urlText: string;
}): PrivacyFetchValidationResult {
  let url: URL
  try {
    url = new URL(urlText)
  } catch {
    return createRejectedResult({
      code: 'invalid_url',
      message: 'The request URL is invalid',
    })
  }

  if (url.protocol !== 'https:') {
    return createRejectedResult({
      code: 'invalid_protocol',
      message: 'Only https URLs are allowed',
    })
  }

  if (url.username !== '' || url.password !== '') {
    return createRejectedResult({
      code: 'invalid_username_or_password',
      message: 'Username and password are not allowed in privacy fetch URLs',
    })
  }

  if (url.port !== '') {
    return createRejectedResult({
      code: 'invalid_port',
      message: 'Explicit ports are not allowed in privacy fetch URLs',
    })
  }

  if (url.hash !== '') {
    return createRejectedResult({
      code: 'invalid_hash',
      message: 'URL fragments are not allowed in privacy fetch URLs',
    })
  }

  return validateWikipediaPrivacyFetchUrl({ url })
}
