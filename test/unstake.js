const { contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, BN, time } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const _require = require('app-root-path').require;
const BlockchainCaller = _require('/util/blockchain_caller');
const chain = new BlockchainCaller(web3);
const {
  $AMPL,
  invokeRebase,
  checkAmplAprox,
  TimeController
} = _require('/test/helper');

const AmpleforthErc20 = contract.fromArtifact('UFragments');
const TokenSpring = contract.fromArtifact('TokenSpring');
const InitialSharesPerToken = 10 ** 6;

const ONE_YEAR = 1 * 365 * 24 * 3600;

let ampl, dist, owner, anotherAccount, penaltyAccount;
async function setupContractAndAccounts () {
  const accounts = await chain.getUserAccounts();
  owner = web3.utils.toChecksumAddress(accounts[0]);
  anotherAccount = web3.utils.toChecksumAddress(accounts[8]);
  penaltyAccount = web3.utils.toChecksumAddress(accounts[5]);

  ampl = await AmpleforthErc20.new();
  await ampl.initialize(owner);
  await ampl.setMonetaryPolicy(owner);

  const startBonus = 33; // 33%
  const bonusPeriod = 5184000; // 60 days
  dist = await TokenSpring.new(ampl.address, ampl.address, 10, startBonus, bonusPeriod,
    InitialSharesPerToken);

  await ampl.transfer(anotherAccount, $AMPL(50000));
  await ampl.approve(dist.address, $AMPL(50000), { from: anotherAccount });
  await ampl.approve(dist.address, $AMPL(50000), { from: owner });

  await dist.setPenaltyAddress(penaltyAccount);
}

async function totalRewardsFor (account) {
  return (await dist.getAccounting.call({ from: account }))[4];
}

describe('unstaking', function () {
  beforeEach('setup contracts', async function () {
    await setupContractAndAccounts();
  });

  describe('unstake', function () {
    describe('when amount is 0', function () {
      it('should fail', async function () {
        await dist.stake($AMPL(50), 10, [], { from: anotherAccount });
        await expectRevert(
          dist.unstake($AMPL(0), [], { from: anotherAccount }),
          'TokenSpring: unstake amount is zero'
        );
      });
    });

    describe('when rebase increases supply', function () {
      beforeEach(async function () {
        await dist.stake($AMPL(50), 10, [], { from: anotherAccount });
        await time.increase(1);
      });
      it('should fail if user tries to unstake more than his balance', async function () {
        await invokeRebase(ampl, +50);
        await expectRevert(
          dist.unstake($AMPL(85), [], { from: anotherAccount }),
          'TokenSpring: unstake amount is greater than total user stakes'
        );
      });
      it('should NOT fail if user tries to unstake his balance', async function () {
        await time.increase(10);
        await invokeRebase(ampl, +50);
        await dist.unstake($AMPL(75), [], { from: anotherAccount });
      });
      it('should fail if there are too few stakingSharesToBurn', async function () {
        await invokeRebase(ampl, 100 * InitialSharesPerToken);
        await expectRevert(
          dist.unstake(1, [], { from: anotherAccount }),
          'TokenSpring: Unable to unstake amount this small'
        );
      });
    });

    describe('when rebase decreases supply', function () {
      beforeEach(async function () {
        await dist.stake($AMPL(50), 10, [], { from: anotherAccount });
        await time.increase(1);
      });
      it('should fail if user tries to unstake more than his balance', async function () {
        await invokeRebase(ampl, -50);
        await expectRevert(
          dist.unstake($AMPL(50), [], { from: anotherAccount }),
          'TokenSpring: unstake amount is greater than total user stakes'
        );
      });
      it('should NOT fail if user tries to unstake his balance', async function () {
        await invokeRebase(ampl, -50);
        await dist.unstake($AMPL(25), [], { from: anotherAccount });
      });
    });

    describe('when single user stakes once', function () {
      // 100 ampls locked for 1 year, user stakes 50 ampls for 1 year
      // user is eligible for 100% of the reward,
      // unstakes 30 ampls - gets forced to remove 50 instead, gets 33% of the reward (100 ampl)
      // user's final balance is 83 ampl, (50 balance + 33 rewards)
      const timeController = new TimeController();
      // stake for full bonus period
      const cdExpirySeconds = 5184000
      beforeEach(async function () {
        await dist.lockTokens($AMPL(100), ONE_YEAR);
        await timeController.initialize();
        await dist.stake($AMPL(50), cdExpirySeconds, [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR);
        await dist.getAccounting({ from: anotherAccount });
        checkAmplAprox(await totalRewardsFor(anotherAccount), 100);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($AMPL(30), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($AMPL(0));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($AMPL(0));
        checkAmplAprox(await totalRewardsFor(anotherAccount), 0); // rewards have been withdrawn
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await ampl.balanceOf.call(anotherAccount);
        await dist.unstake($AMPL(30), [], { from: anotherAccount });
        const b = await ampl.balanceOf.call(anotherAccount);
        checkAmplAprox(b.sub(_b), 150);
      });
      it('should log Unstaked', async function () {
        // should remove all of the 50 contract
        const r = await dist.unstake($AMPL(30), [], { from: anotherAccount });
        expectEvent(r, 'Unstaked', {
          user: anotherAccount,
          amount: $AMPL(50),
          total: $AMPL(0)
        });
      });
      it('should log TokensClaimed', async function () {
        const r = await dist.unstake($AMPL(30), [], { from: anotherAccount });
        expectEvent(r, 'TokensClaimed', {
          user: anotherAccount,
          amount: $AMPL(100)
        });
      });
    });

    describe('when single user unstake early with early bonus', function () {
      // Start bonus = 33%, Bonus Period = 60 days.
      // 1000 ampls locked for 1 hour, so all will be unlocked by test-time.
      // user stakes 500 ampls for 12 hours, 1/120th of the period.
      // user is eligible for 33% (actual is 33.5583, we cut off decimals) of the max reward = 330,
      // unstakes 250 ampls, gets 500 original + 330 ampls
      // user's final balance is 830 ampl, (0 remains staked), eligible rewards (330 ampl)
      const timeController = new TimeController();
      const ONE_HOUR = 3600;
      const cdExpirySeconds = ONE_HOUR * 11
      beforeEach(async function () {
        await dist.lockTokens($AMPL(1000), ONE_HOUR);
        timeController.initialize();
        await dist.stake($AMPL(500), cdExpirySeconds, [], { from: anotherAccount });
        await timeController.advanceTime(12 * ONE_HOUR); // makes 1000
        await dist.getAccounting({ from: anotherAccount });
        checkAmplAprox(await totalRewardsFor(anotherAccount), 1000); //optimistically expects max bonus time
      });
      it('should update the total staked and rewards', async function () {
        // unstakes all of the initial 500 and takes 33% of the rewards
        const r = await dist.unstake($AMPL(250), [], { from: anotherAccount });
        expectEvent(r, 'Unstaked', {
          user: anotherAccount,
          amount: $AMPL(500),
          total: $AMPL(0)
        });
        expectEvent(r, 'TokensClaimed', {
          user: anotherAccount,
          amount: $AMPL(330)
        });

        expect(await dist.totalStaked.call()).to.be.bignumber.equal($AMPL(0));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($AMPL(0));
        checkAmplAprox(await totalRewardsFor(anotherAccount), 0); // 0 rewards left
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await ampl.balanceOf.call(anotherAccount); // currently down 500 from staking
        await dist.unstake($AMPL(250), [], { from: anotherAccount }); // unstakes the original 500
        const b = await ampl.balanceOf.call(anotherAccount); //has 500 + 330 rewards
        checkAmplAprox(b.sub(_b), 830); // received all coins back, and 1000 rewards
      });
      it('should log Unstaked', async function () {
        const r = await dist.unstake($AMPL(250), [], { from: anotherAccount }); // unstakes 500
        expectEvent(r, 'Unstaked', {
          user: anotherAccount,
          amount: $AMPL(500),
          total: $AMPL(0)
        });
      });
      it('should log TokensClaimed', async function () {
        const r = await dist.unstake($AMPL(250), [], { from: anotherAccount });
        expectEvent(r, 'TokensClaimed', {
          user: anotherAccount,
          amount: $AMPL(330) // receives 33% of rewards because of multiplier
        });
      });
    });

    describe('when single user stakes many times', function () {
      // 100 ampls locked for 1 year,
      // user stakes 50 ampls x2 [100 ampls unlocked in this time ]
      // unstakes 30 ampls (received 50 back), gets 33%/2  of the unlocked reward (51) 8.415
      // user's final balance is 40 ampl
      const timeController = new TimeController();
      const ONE_HOUR = 3600;
      const cdExpirySeconds = ONE_HOUR * 12
      beforeEach(async function () {
        await dist.lockTokens($AMPL(100), ONE_YEAR);
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 100);
        await dist.stake($AMPL(50), cdExpirySeconds, [], { from: anotherAccount });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($AMPL(50), cdExpirySeconds, [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.getAccounting({ from: anotherAccount });
      });
      it('checkTotalRewards', async function () {
        checkAmplAprox(await totalRewardsFor(anotherAccount), 51);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($AMPL(30), [], { from: anotherAccount }); // takes out 50, rewards 8.16
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($AMPL(50));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($AMPL(50));
        checkAmplAprox(await totalRewardsFor(anotherAccount), 42.585);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await ampl.balanceOf.call(anotherAccount);
        await dist.unstake($AMPL(30), [], { from: anotherAccount }); // unstakes 50
        const b = await ampl.balanceOf.call(anotherAccount);
        checkAmplAprox(b.sub(_b), 58.415); // 50 unstaked + 8.415 reward
      });
    });

    describe('when single user performs unstake many times', function () {
      // 100 ampls locked for 1 year,
      // user stakes 10 ampls, waits 1 year, stakes 10 ampls, waits 1 year,
      // unstakes 5 ampl (should take out 10), unstakes 5 ampl (should take out 10), unstakes 5 ampl (throws error, no balance left)
      // all rewards should equal 16.5%(33/2)
      const timeController = new TimeController();
      const ONE_HOUR = 3600;
      const cdExpirySeconds = ONE_HOUR * 12
      beforeEach(async function () {
        await dist.lockTokens($AMPL(100), ONE_YEAR);
        await timeController.initialize();
        await dist.stake($AMPL(10), cdExpirySeconds, [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR);
        await dist.stake($AMPL(10), cdExpirySeconds, [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR);
        await dist.getAccounting({ from: anotherAccount });
        checkAmplAprox(await totalRewardsFor(anotherAccount), 100);
      });

      it('should use updated user accounting', async function () {
        const r1 = await dist.unstake($AMPL(5), [], { from: anotherAccount }); // unstakes 10, receives .165 * 100
        expectEvent(r1, 'TokensClaimed', {
          user: anotherAccount
        });
        const l1 = r1.logs.filter(l => l.event === 'TokensClaimed')[0];
        const claim1 = l1.args.amount;

        const r2 = await dist.unstake($AMPL(5), [], { from: anotherAccount }); // unstakes 10, receives (100 - (.165 * 100)) * .33
        expectEvent(r2, 'TokensClaimed', {
          user: anotherAccount
        });
        const l2 = r2.logs.filter(l => l.event === 'TokensClaimed')[0];
        const claim2 = l2.args.amount;
        const ratio = claim2.mul(new BN(100)).div(claim1);
        expect(ratio).to.be.bignumber.equal('167');
      });
    });

    describe('when multiple users stake once', function () {
      // 100 ampls locked for 1 year,
      // userA stakes 50 ampls for 3/4 year, userb stakes 50 ampl for 1/2 year, total unlocked 75 ampl
      // userA unstakes 30 ampls, gets 36% of the unlocked reward (27 ampl) ~ [30 * 0.75 / (50*0.75+50*0.5) * 75]
      // user's final balance is 57 ampl
      const timeController = new TimeController();
      const ONE_HOUR = 3600;
      const cdExpirySeconds = ONE_HOUR * 12
      beforeEach(async function () {
        await dist.lockTokens($AMPL(100), ONE_YEAR);
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 100); // unlocks 1
        await dist.stake($AMPL(50), cdExpirySeconds, [], { from: anotherAccount });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4); // unlock 25
        await dist.stake($AMPL(50), cdExpirySeconds, []);
        await timeController.advanceTime(ONE_YEAR / 2); // unlocks 50
        await dist.getAccounting({ from: anotherAccount });
        await dist.getAccounting();
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($AMPL(100));
        checkAmplAprox(await totalRewardsFor(anotherAccount), 38); //optimistically rewards full bonus
        checkAmplAprox(await totalRewardsFor(owner), 38); //optimistically rewards full bonus
      });
      it('checkTotalRewards', async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($AMPL(100));
        checkAmplAprox(await totalRewardsFor(anotherAccount), 38);
        checkAmplAprox(await totalRewardsFor(owner), 38);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($AMPL(30), [], { from: anotherAccount }); // takes out 50
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($AMPL(50));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($AMPL(0));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($AMPL(50));
        checkAmplAprox(await totalRewardsFor(anotherAccount), 0);
        checkAmplAprox(await totalRewardsFor(owner), 63.46);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await ampl.balanceOf.call(anotherAccount);
        await dist.unstake($AMPL(30), [], { from: anotherAccount }); // takes out 50 + reward of 12.54
        const b = await ampl.balanceOf.call(anotherAccount);
        checkAmplAprox(b.sub(_b), 62.54);
      });
    });

    describe('when multiple users stake many times', function () {
      // 10000 ampls locked for 1 year,
      // userA stakes 5000 ampls for 3/4 year, and 5000 ampls for 1/4 year
      // userb stakes 5000 ampls for 1/2 year and 3000 ampls for 1/4 year
      // userA unstakes 10000 ampls, gets 60.60% of the unlocked reward (4545 ampl)
      //        ~ [5000*0.75+5000*0.25 / (5000*0.75+5000*0.25+5000*0.5+3000*0.25) * 7500]
      // user's final balance is 14545 ampl
      // userb unstakes 8000 ampls, gets the 10955 ampl
      const timeController = new TimeController();
      const ONE_HOUR = 3600;
      const cdExpirySeconds = ONE_HOUR * 12
      const rewardsAnotherAccount = 7500 * (10000.0 / 18000.0);
      const rewardsOwner = 7500.0 * (8000.0 / 18000.0);

      beforeEach(async function () {
        await timeController.executeAsBlock(function () {
          dist.lockTokens($AMPL(10000), ONE_YEAR);
          dist.stake($AMPL(5000), cdExpirySeconds, [], { from: anotherAccount });
        });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4); // unlocks 2500
        await dist.stake($AMPL(5000), cdExpirySeconds, []);
        await timeController.advanceTime(ONE_YEAR / 4); // unlocks 2500
        await dist.stake($AMPL(5000), cdExpirySeconds, [], { from: anotherAccount });
        await dist.stake($AMPL(3000), cdExpirySeconds, []);
        await timeController.advanceTime(ONE_YEAR / 4); // unlocks 2500
        await dist.getAccounting({ from: anotherAccount });
        await dist.getAccounting();
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($AMPL(18000));
        checkAmplAprox(await totalRewardsFor(anotherAccount), rewardsAnotherAccount);
        checkAmplAprox(await totalRewardsFor(owner), rewardsOwner);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($AMPL(10000), [], { from: anotherAccount }); //removes 10k, rewarded rewardsAnotherAccount * 0.33 bonus (1375)
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($AMPL(8000));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($AMPL(0));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($AMPL(8000));
        checkAmplAprox(await totalRewardsFor(anotherAccount), 0);
        checkAmplAprox(await totalRewardsFor(owner), (7500.0 - 1375.0));
        await dist.unstake($AMPL(8000), []);
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($AMPL(0));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($AMPL(0));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($AMPL(0));
        checkAmplAprox(await totalRewardsFor(anotherAccount), 0);
        checkAmplAprox(await totalRewardsFor(owner), 0);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const b1 = await ampl.balanceOf.call(anotherAccount);
        await dist.unstake($AMPL(10000), [], { from: anotherAccount }); // receives 10k
        const b2 = await ampl.balanceOf.call(anotherAccount);
        checkAmplAprox(b2.sub(b1), 10000 + (rewardsAnotherAccount * 0.33));
        const b3 = await ampl.balanceOf.call(owner);
        await dist.unstake($AMPL(8000), []);
        const b4 = await ampl.balanceOf.call(owner);
        checkAmplAprox(b4.sub(b3), 8000 + ((7500.0 - 1375.0) * 0.33));
      });
    });
  });

  describe('unstakeQuery', function () {
    // 100 ampls locked for 1 year, user stakes 50 ampls for 1 year
    // user is eligible for 100% of the reward,
    // unstakes 30 ampls, gets 60% of the reward (60 ampl)
    const timeController = new TimeController();
    const ONE_HOUR = 3600;
    const cdExpirySeconds = ONE_HOUR * 12
    beforeEach(async function () {
      await dist.lockTokens($AMPL(100), ONE_YEAR);
      await dist.stake($AMPL(50), cdExpirySeconds, [], { from: anotherAccount });
      await timeController.initialize();
      await timeController.advanceTime(ONE_YEAR);
      await dist.getAccounting({ from: anotherAccount });
    });
    it('should return the reward amount', async function () {
      checkAmplAprox(await totalRewardsFor(anotherAccount), 100);
      const a = await dist.unstakeQuery.call($AMPL(30), { from: anotherAccount }); // unstakes 50
      checkAmplAprox(a, 33);
    });
  });

  describe('when a user stakes for 60 days and unstakes too early', function () {
    // 100 ampls locked for 1 year, user stakes 50 ampls for 2 months
    // unstakes 50 ampls after 1 month
    // should have a penalty of 0.25% of the original 50 ~12.5
    const timeController = new TimeController();
    const cdExpirySeconds = 60 * 24 * 3600;
    beforeEach(async function () {
      await dist.lockTokens($AMPL(100), ONE_YEAR);
      await timeController.initialize();
      const s = await dist.stake($AMPL(50), cdExpirySeconds, [], { from: anotherAccount });
      await timeController.advanceTime(30 * 24 * 3600); // moves forward 1 month, unlocks 8.33 (2628000 seconds)
      await dist.getAccounting({ from: anotherAccount });
    });
    it('should return the original amount minus penalties (no rewards given)', async function () {
      //console.log(timeController.currentTime.toString())
      const r = await dist.unstake($AMPL(30), [], { from: anotherAccount }); // unstakes 50
      // penalty = 50 * ((60 - 30)/60) / 2 = 12.5
      expectEvent(r, 'Unstaked', {
        user: anotherAccount,
        amount: $AMPL(50 - 12.5),
        total: $AMPL(0),
        penaltyAmount: $AMPL(12.5)
      });
      expectEvent(r, 'TokensClaimed', {
        user: anotherAccount,
        amount: $AMPL(0)
      });

      const b = await ampl.balanceOf.call(penaltyAccount);
      checkAmplAprox(b, 12.5);
    });
  });
});
