import { SignedSamlRequestCacheProvider } from './saml-auth.service';

describe('SignedSamlRequestCacheProvider', () => {
  const secret = 'test-session-secret';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts a signed request id once and rejects replay after removal', async () => {
    const provider = new SignedSamlRequestCacheProvider(secret, 60_000);
    const requestId = provider.createRequestId();

    await expect(provider.getAsync(requestId)).resolves.toBeTruthy();
    await expect(provider.removeAsync(requestId)).resolves.toBeTruthy();
    await expect(provider.getAsync(requestId)).resolves.toBeNull();
  });

  it('rejects tampered and expired request ids', async () => {
    const provider = new SignedSamlRequestCacheProvider(secret, 60_000);
    const requestId = provider.createRequestId();
    const tampered =
      requestId.slice(0, -1) + (requestId.endsWith('a') ? 'b' : 'a');

    await expect(provider.getAsync(tampered)).resolves.toBeNull();

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const shortLivedProvider = new SignedSamlRequestCacheProvider(secret, 1);
    const shortLivedId = shortLivedProvider.createRequestId();
    jest.spyOn(Date, 'now').mockReturnValue(now + 2);

    await expect(shortLivedProvider.getAsync(shortLivedId)).resolves.toBeNull();
  });
});
