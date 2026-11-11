# Client version requirements

Add an entry to the [client feature registry](../apps/api-go/internal/backend/client_features.json) when a feature requires a newer web or native bundle. Give it a stable ID, the first compatible release as a three-part `minVersion`, and names in English and Persian. Set `gameKinds` for game catalog entries.

The game API filters versioned lobbies and checks the minimum when a client creates, views, watches, or changes a game. Clients declare the bundled version through `clientVersion`. Requests from older clients without that field can still use the original catalog. Version checks cover compatibility. Keep the existing authentication, membership, and action checks at the feature boundary.

For another UI feature, use its registry ID and the advertised requirement from `/features` to choose between the control and `ClientFeatureNotice`. Check compatibility wherever the server would otherwise send data an older client cannot render. The global announcement area also surfaces the requirement, including on older releases that use the legacy announcement payload.

The new voice games require 1.2.8. Publish compatible Windows and Android builds through their normal update channels when rolling out the matching server.
