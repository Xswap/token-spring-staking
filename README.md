# Token Spring

A smart-contract based mechanism to distribute tokens over time, inspired loosely by Ampl's Geyser and HEX. The Spring resembles a traditional CD based system.

Distribution tokens are added to a locked pool in the contract and become unlocked over time according to a once-configurable unlock schedule. Once unlocked, they are available to be claimed by users.

A user may deposit tokens to accrue ownership share over the unlocked pool. This owner share is a function of the number of tokens deposited as well as the length of the lock time promised.

If a user revokes their tokens from the pool too early, there is a penalty that gets applied to the received funds with 0 rewards paid out. The calculation for the penalty is: (% of time left / 2) * deposited staking tokens.

The official Spring contract addresses are (by target):
- UniswapV2 [ETH/COIL](https://uniswap.exchange/swap?outputCurrency=0x3936Ad01cf109a36489d93cabdA11cF062fd3d48) Pool: [0x68051c65c310aa210bd8e79ed7aa1b0ac7e6db52](https://etherscan.io/address/0x68051c65c310aa210bd8e79ed7aa1b0ac7e6db52)

## Table of Contents

- [Install](#install)
- [Testing](#testing)
- [Contribute](#contribute)
- [License](#license)


## Install

```bash
# Install project dependencies
npm install

# Install ethereum local blockchain(s) and associated dependencies
npx setup-local-chains
```

## Testing

``` bash
# You can use the following command to start a local blockchain instance
npx start-chain [ganacheUnitTest|gethUnitTest]

# Run all unit tests
npm test

# Run unit tests in isolation
npx mocha test/staking.js --exit
```

## Contribute

To report bugs within this package, please create an issue in this repository.
When submitting code ensure that it is free of lint errors and has 100% test coverage.

``` bash
# Lint code
npm run lint

# View code coverage
npm run coverage
```

## License

[GNU General Public License v3.0 (c) 2020 coilcrypto.com](./LICENSE)
[GNU General Public License v3.0 (c) 2020 Fragments, Inc.](./LICENSE)
