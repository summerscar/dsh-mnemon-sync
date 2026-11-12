# Changelog

## Unreleased

- New plugin: connect AgentScope Platform to DSH.
  - Optional OpenAI-compatible model provider, off by default and switched on from the settings panel. The route uses the Host's own pi-ai adapter, so it needs a DSH build that ships it; an older Host leaves the route off and the rest of the plugin working.
  - Model catalog you can fetch from the API, add to by hand, and edit row by row (context window, output cap, text/image input, reasoning tiers).
  - Credit and redeemable-contribution readout under the composer.
  - Settings panel: daily check-in, credit balance, contribution grants, and a paginated usage-detail query.
