/**
 * @probatio/metadata — token names, symbols and images.
 *
 * Splits cleanly in two. The on-chain half is an account decode and is as
 * trustworthy as any other chain read. The off-chain half is a JSON document on
 * somebody else's server, chosen by whoever launched the token, and is treated
 * accordingly.
 */

export {
  ACCOUNT_TYPE_OFFSET,
  TLV_START,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_METADATA_EXTENSION,
  TOKEN_PROGRAM_ID,
  decodeToken2022Metadata,
  hasExtensions,
  readExtensions,
} from './token2022';
export type { TlvEntry, Token2022Metadata } from './token2022';

export { METADATA_PROGRAM_ID, decodeTokenMetadata, metadataAddress } from './metaplex';
export type { TokenMetadataAccount } from './metaplex';

export { IPFS_GATEWAY, UnsafeUriError, isFetchableUri, resolveMetadataUri } from './uri';

export { OffchainFetchError, fetchOffchainMetadata } from './offchain';
export type { FetchOptions, OffchainMetadata } from './offchain';

export { MetadataReader } from './reader';
export type { MetadataStandard, OnchainTokenInfo } from './reader';
