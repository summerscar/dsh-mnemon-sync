# Changelog

## Unreleased

- **Security**: All HTTP endpoints now go through Host authentication
  (`connection.requestRejection`). Previously, when Host authentication was
  unavailable, requests were admitted and could reach endpoints that read
  credentials and reset the model key. Hosts exposing only `authorizeIndex`
  remain supported; if the service is missing or neither hook is available,
  requests are rejected with 401 instead of falling back to Host/Origin or
  loopback checks.
- New plugin: connect AgentScope Platform to DSH.
  - **Account pool.** Keep several platform accounts side by side. The account
    marked *Current* pays for new requests; the row carrying it is highlighted,
    so which account is billing is legible before reading any text. Add, rename,
    disable, remove and probe accounts from the panel, or let the plugin pick a
    higher-credit account when the current one falls below a threshold.
  - **Switching is not failover.** Changing the account affects the next request;
    a reply already streaming keeps running on the key it took. A request that
    fails is not retried on another account.
  - **One measurement for every credit figure.** The readout under the composer
    and the account row in the settings panel come from the same read, so they
    cannot disagree about the balance or the "last refreshed" instant.
  - Optional OpenAI-compatible model provider, off by default and switched on
    from the settings panel. The route uses the Host's own pi-ai adapter, so it
    needs a DSH build that ships it; an older Host leaves the route off and the
    rest of the plugin working.
  - Model catalog you can fetch from the API, add to by hand, and edit row by row
    (context window, output cap, text/image input, reasoning tiers).
  - Credit and redeemable-contribution readout under the composer, shown only
    while the session runs on the AgentScope model.
  - Settings panel: the account pool, the provider switch, the catalog, the daily
    check-in, the credit balance, contribution grants, the usage-detail query and
    the console's price list. Sections that are configured once are collapsed
    with a one-line summary.
  - Timestamps are stated in one zone (UTC+8), the same clock the check-in uses,
    and labelled as such.
