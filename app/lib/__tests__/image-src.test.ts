import { describe, expect, it } from 'vitest';
import { imageSrc } from '../image-src';

/**
 * Which gateway a token picture is fetched from.
 *
 * Every case here is a real URL taken off the Explore board, because the
 * failures this guards against are not hypothetical: the pictures were blank
 * on the live site and the URLs were the reason.
 */

const GW = 'https://pump.mypinata.cloud/ipfs';

describe('imageSrc', () => {
  it('re-points a gateway that refuses browsers', () => {
    // Measured: 200 to curl, 403 to anything sending a browser User-Agent.
    expect(imageSrc('https://ipfs.io/ipfs/QmYacSFQ4ShAzjfvPuAyxY2AsdePadbnjhxcRZrxtwddj6')).toBe(
      `${GW}/QmYacSFQ4ShAzjfvPuAyxY2AsdePadbnjhxcRZrxtwddj6`,
    );
  });

  it('re-points a gateway that no longer exists', () => {
    // Cloudflare retired this one. Fifteen tokens on the board pointed at it.
    expect(imageSrc('https://cf-ipfs.com/ipfs/QmcXf4RN3JWw54rjTBwrvxTpnJNAd3ZoRwSdN5XKxppDiA')).toBe(
      `${GW}/QmcXf4RN3JWw54rjTBwrvxTpnJNAd3ZoRwSdN5XKxppDiA`,
    );
  });

  /*
   * The point of not keeping a deny list.
   *
   * A gateway nobody has had trouble with yet is re-pointed exactly like one
   * that has already broken. Listing the bad ones means learning each new
   * failure from a screenshot of blank cards, and the CID is the file either
   * way, so there is nothing to lose by not asking who is serving it.
   */
  it('re-points a gateway that currently works, so a list never has to be kept', () => {
    expect(imageSrc('https://desperate-moccasin-minnow.myfilebase.com/ipfs/QmRnFYrjbJhGL8')).toBe(
      `${GW}/QmRnFYrjbJhGL8`,
    );
  });

  it('handles the ipfs:// scheme, with or without a redundant prefix', () => {
    expect(imageSrc('ipfs://QmRnFYrjbJhGL8')).toBe(`${GW}/QmRnFYrjbJhGL8`);
    expect(imageSrc('ipfs://ipfs/QmRnFYrjbJhGL8')).toBe(`${GW}/QmRnFYrjbJhGL8`);
  });

  /*
   * A CID can address a directory, and the picture is a file inside it.
   * Truncating to the CID resolves the listing rather than the image.
   */
  it('keeps a path below the CID', () => {
    expect(imageSrc('https://ipfs.io/ipfs/QmDir/image.png')).toBe(`${GW}/QmDir/image.png`);
  });

  it('keeps a query, which some gateways use to address the file', () => {
    expect(imageSrc('https://ipfs.io/ipfs/QmDir?filename=a.png')).toBe(
      `${GW}/QmDir?filename=a.png`,
    );
  });

  /*
   * Not everything is IPFS. These hosts serve the picture themselves and there
   * is no CID to look up, so rewriting them would turn a working image into a
   * 404 at a gateway that has never heard of it.
   */
  it('leaves a plain hosted image alone', () => {
    for (const url of [
      'https://pbs.twimg.com/media/HP5xHLHasAASTHL?format=jpg',
      'https://coin-images.coingecko.com/coins/images/54109/large/I.png',
      'https://images.pump.fun/coin-image/Aj3zBD5du8HF5ufGpVvffkLCXxgktwwYcyP',
    ]) {
      expect(imageSrc(url)).toBe(url);
    }
  });

  it('leaves something that is not a URL alone rather than throwing', () => {
    expect(imageSrc('not a url')).toBe('not a url');
  });

  it('has nothing to show for an empty or missing image', () => {
    expect(imageSrc(null)).toBeNull();
    expect(imageSrc(undefined)).toBeNull();
    expect(imageSrc('')).toBeNull();
  });

  /*
   * A javascript: or data: URL must never be handed to an img src on the
   * strength of containing the characters "/ipfs/".
   */
  it('ignores a scheme that is not http, https or ipfs', () => {
    expect(imageSrc('javascript:alert(1)/ipfs/x')).toBe('javascript:alert(1)/ipfs/x');
  });
});
