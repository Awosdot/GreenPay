#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, token, vec, Address, Bytes, Env, IntoVal, String, Symbol,
};

// ─── Constants ───────────────────────────────────────────────────────────────

/// 4 years × 365 days × 24 h × 3600 s ÷ 5 s per ledger
const MAX_LOCK_LEDGERS: u32 = 2_102_400;

/// 7 days × 24 h × 3600 s ÷ 5 s per ledger
const MIN_LOCK_LEDGERS: u32 = 120_960;

/// Minimum voting window (7 days)
const MIN_VOTING_WINDOW: u32 = 120_960;

// ─── Data types ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct Lock {
    pub amount: i128,
    pub unlock_ledger: u32,
    pub created_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalStage {
    Discussion,
    SnapshotVote,
    Execution,
    Defeated,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Proposal {
    pub id: u64,
    pub title: String,
    pub description: String,
    pub target_contract: Address,
    pub function: Symbol,
    pub calldata: Bytes,
    pub proposer: Address,
    pub stage: ProposalStage,
    pub snapshot_ledger: u32,
    pub vote_end_ledger: u32,
    pub votes_for: i128,
    pub votes_against: i128,
    pub executable_from_ledger: u32,
    pub created_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Config {
    pub gp_token: Address,
    pub quorum: i128,
    pub voting_period_ledgers: u32,
    pub timelock_ledgers: u32,
    pub dao_admin: Address,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub voting_power: i128,
}

#[contracttype]
pub enum DataKey {
    Config,
    Lock(Address),
    Proposal(u64),
    Snapshot(u64, Address),
    ProposalCount,
    AllowedTarget(Address, Symbol),
}

// ─── Contract ────────────────────────────────────────────────────────────────

#[contract]
pub struct DaoGovernanceContract;

#[contractimpl]
impl DaoGovernanceContract {
    // ─── Requirement 1: Initialisation ─────────────────────────────────────

    pub fn initialize(
        env: Env,
        gp_token: Address,
        quorum: i128,
        voting_period_ledgers: u32,
        timelock_ledgers: u32,
        dao_admin: Address,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic!("already initialized");
        }
        if quorum <= 0 {
            panic!("quorum must be positive");
        }
        if voting_period_ledgers < MIN_VOTING_WINDOW {
            panic!("voting period too short");
        }
        if timelock_ledgers == 0 {
            panic!("timelock must be positive");
        }
        let config = Config {
            gp_token,
            quorum,
            voting_period_ledgers,
            timelock_ledgers,
            dao_admin,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
        env.storage()
            .instance()
            .extend_ttl(MIN_VOTING_WINDOW, MAX_LOCK_LEDGERS);
        env.events().publish((Symbol::new(&env, "init"),), config);
    }

    pub fn get_config(env: Env) -> Config {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized")
    }

    // ─── Requirement 2: GP Token Locking ───────────────────────────────────

    pub fn lock_tokens(env: Env, voter: Address, amount: i128, lock_duration_ledgers: u32) {
        voter.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }
        if lock_duration_ledgers < MIN_LOCK_LEDGERS {
            panic!("lock duration too short");
        }
        if lock_duration_ledgers > MAX_LOCK_LEDGERS {
            panic!("lock duration too long");
        }

        let lock_key = DataKey::Lock(voter.clone());
        if env.storage().persistent().has(&lock_key) {
            let existing: Lock = env.storage().persistent().get(&lock_key).unwrap();
            if existing.unlock_ledger > env.ledger().sequence() {
                panic!("existing lock must be extended or expired");
            }
        }

        let current_ledger = env.ledger().sequence();
        let unlock_ledger = current_ledger
            .checked_add(lock_duration_ledgers)
            .expect("unlock ledger overflow");

        let lock = Lock {
            amount,
            unlock_ledger,
            created_ledger: current_ledger,
        };
        env.storage().persistent().set(&lock_key, &lock);
        extend_persistent_ttl(&env, &lock_key);

        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        let token_client = token::Client::new(&env, &config.gp_token);
        token_client.transfer(&voter, &env.current_contract_address(), &amount);

        env.events().publish(
            (Symbol::new(&env, "locked"), voter),
            (amount, unlock_ledger),
        );
    }

    pub fn get_lock(env: Env, voter: Address) -> Lock {
        let lock_key = DataKey::Lock(voter.clone());
        if env.storage().persistent().has(&lock_key) {
            let lock: Lock = env.storage().persistent().get(&lock_key).unwrap();
            extend_persistent_ttl(&env, &lock_key);
            lock
        } else {
            Lock {
                amount: 0,
                unlock_ledger: 0,
                created_ledger: 0,
            }
        }
    }

    // ─── Requirement 3: Lock Extension ─────────────────────────────────────

    pub fn extend_lock(env: Env, voter: Address, new_unlock_ledger: u32) {
        voter.require_auth();
        let lock_key = DataKey::Lock(voter.clone());
        if !env.storage().persistent().has(&lock_key) {
            panic!("no active lock");
        }
        let mut lock: Lock = env.storage().persistent().get(&lock_key).unwrap();
        if new_unlock_ledger <= lock.unlock_ledger {
            panic!("new unlock must be later");
        }
        let max_unlock = env
            .ledger()
            .sequence()
            .checked_add(MAX_LOCK_LEDGERS)
            .expect("max unlock overflow");
        if new_unlock_ledger > max_unlock {
            panic!("lock duration too long");
        }
        lock.unlock_ledger = new_unlock_ledger;
        env.storage().persistent().set(&lock_key, &lock);
        extend_persistent_ttl(&env, &lock_key);
        env.events().publish(
            (Symbol::new(&env, "extend"), voter.clone()),
            new_unlock_ledger,
        );
    }

    // ─── Requirement 4: Token Withdrawal ───────────────────────────────────

    pub fn withdraw(env: Env, voter: Address) {
        voter.require_auth();
        let lock_key = DataKey::Lock(voter.clone());
        if !env.storage().persistent().has(&lock_key) {
            panic!("no lock found");
        }
        let lock: Lock = env.storage().persistent().get(&lock_key).unwrap();
        if env.ledger().sequence() < lock.unlock_ledger {
            panic!("lock not yet expired");
        }
        let amount = lock.amount;
        env.storage().persistent().remove(&lock_key);

        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        let token_client = token::Client::new(&env, &config.gp_token);
        token_client.transfer(&env.current_contract_address(), &voter, &amount);

        env.events()
            .publish((Symbol::new(&env, "withdrw"), voter), amount);
    }

    // ─── Requirement 5: Voting Power Calculation ───────────────────────────

    pub fn get_voting_power(env: Env, voter: Address, at_ledger: u32) -> i128 {
        let lock_key = DataKey::Lock(voter.clone());
        if !env.storage().persistent().has(&lock_key) {
            return 0;
        }
        let lock: Lock = env.storage().persistent().get(&lock_key).unwrap();
        extend_persistent_ttl(&env, &lock_key);
        if at_ledger >= lock.unlock_ledger || at_ledger < lock.created_ledger {
            return 0;
        }
        let remaining = lock.unlock_ledger - at_ledger;
        (lock.amount * remaining as i128) / MAX_LOCK_LEDGERS as i128
    }

    pub fn get_snapshot_power(env: Env, voter: Address, proposal_id: u64) -> i128 {
        let snap_key = DataKey::Snapshot(proposal_id, voter.clone());
        if env.storage().persistent().has(&snap_key) {
            let snap: Snapshot = env.storage().persistent().get(&snap_key).unwrap();
            extend_persistent_ttl(&env, &snap_key);
            snap.voting_power
        } else {
            0
        }
    }

    // ─── Execution Target Allowlist ─────────────────────────────────────────
    //
    // execute_proposal invokes proposal.target_contract/function with
    // proposer-supplied calldata. Without a restriction here, a successful
    // vote would let a proposal invoke arbitrary calldata against any
    // contract/function pair. Only the dao_admin (the same authority that
    // can already force-advance a proposal past Discussion) may change the
    // allowlist, and the pair is checked both when a proposal is created and
    // again immediately before execution, so removing an entry after a
    // proposal is queued still blocks it from running.

    pub fn add_allowed_target(
        env: Env,
        caller: Address,
        target_contract: Address,
        function: Symbol,
    ) {
        caller.require_auth();
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        if caller != config.dao_admin {
            panic!("not authorised to modify allowlist");
        }
        let key = DataKey::AllowedTarget(target_contract.clone(), function.clone());
        env.storage().persistent().set(&key, &true);
        extend_persistent_ttl(&env, &key);
        env.events()
            .publish((Symbol::new(&env, "tgt_add"),), (target_contract, function));
    }

    pub fn remove_allowed_target(
        env: Env,
        caller: Address,
        target_contract: Address,
        function: Symbol,
    ) {
        caller.require_auth();
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        if caller != config.dao_admin {
            panic!("not authorised to modify allowlist");
        }
        let key = DataKey::AllowedTarget(target_contract.clone(), function.clone());
        env.storage().persistent().remove(&key);
        env.events()
            .publish((Symbol::new(&env, "tgt_rmv"),), (target_contract, function));
    }

    pub fn is_allowed_target(env: Env, target_contract: Address, function: Symbol) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::AllowedTarget(target_contract, function))
    }

    // ─── Requirement 6: Proposal Creation ──────────────────────────────────

    pub fn create_proposal(
        env: Env,
        proposer: Address,
        title: String,
        description: String,
        target_contract: Address,
        function: Symbol,
        calldata: Bytes,
    ) -> u64 {
        proposer.require_auth();
        let current = env.ledger().sequence();
        let power = Self::get_voting_power(env.clone(), proposer.clone(), current);
        if power <= 0 {
            panic!("insufficient voting power to propose");
        }
        let allow_key = DataKey::AllowedTarget(target_contract.clone(), function.clone());
        if !env.storage().persistent().has(&allow_key) {
            panic!("target/function not allowlisted");
        }
        extend_persistent_ttl(&env, &allow_key);
        let count: u64 = env
            .storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0);
        let proposal_id = count.checked_add(1).expect("proposal id overflow");
        let proposal = Proposal {
            id: proposal_id,
            title,
            description,
            target_contract,
            function,
            calldata,
            proposer,
            stage: ProposalStage::Discussion,
            snapshot_ledger: 0,
            vote_end_ledger: 0,
            votes_for: 0,
            votes_against: 0,
            executable_from_ledger: 0,
            created_ledger: current,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        extend_persistent_ttl(&env, &DataKey::Proposal(proposal_id));
        env.storage()
            .instance()
            .set(&DataKey::ProposalCount, &proposal_id);
        env.storage()
            .instance()
            .extend_ttl(MIN_VOTING_WINDOW, MAX_LOCK_LEDGERS);
        env.events()
            .publish((Symbol::new(&env, "prop_new"), proposal_id), ());
        proposal_id
    }

    pub fn get_proposal(env: Env, proposal_id: u64) -> Proposal {
        let key = DataKey::Proposal(proposal_id);
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        extend_persistent_ttl(&env, &key);
        proposal
    }

    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }

    // ─── Requirement 7: Discussion → Snapshot ──────────────────────────────

    pub fn advance_to_snapshot(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        let key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        if proposal.stage != ProposalStage::Discussion {
            panic!("invalid stage transition");
        }
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");
        if caller != config.dao_admin {
            let power =
                Self::get_voting_power(env.clone(), caller.clone(), env.ledger().sequence());
            if power <= 0 {
                panic!("not authorised to advance proposal");
            }
        }
        let current = env.ledger().sequence();
        proposal.stage = ProposalStage::SnapshotVote;
        proposal.snapshot_ledger = current;
        proposal.vote_end_ledger = current
            .checked_add(config.voting_period_ledgers)
            .expect("vote end overflow");
        proposal.votes_for = 0;
        proposal.votes_against = 0;
        env.storage().persistent().set(&key, &proposal);
        extend_persistent_ttl(&env, &key);
        env.events().publish(
            (Symbol::new(&env, "snap_str"), proposal_id),
            (proposal.snapshot_ledger, proposal.vote_end_ledger),
        );
    }

    // ─── Requirement 8: Snapshotted Voting ─────────────────────────────────

    pub fn cast_vote(env: Env, voter: Address, proposal_id: u64, approve: bool) {
        voter.require_auth();
        let key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        if proposal.stage != ProposalStage::SnapshotVote {
            panic!("voting not active");
        }
        if env.ledger().sequence() > proposal.vote_end_ledger {
            panic!("voting period closed");
        }
        let snap_key = DataKey::Snapshot(proposal_id, voter.clone());
        if env.storage().persistent().has(&snap_key) {
            panic!("already voted");
        }
        let power = Self::get_voting_power(env.clone(), voter.clone(), proposal.snapshot_ledger);
        if power <= 0 {
            panic!("no voting power at snapshot");
        }
        let snapshot = Snapshot {
            voting_power: power,
        };
        env.storage().persistent().set(&snap_key, &snapshot);
        extend_persistent_ttl(&env, &snap_key);

        if approve {
            proposal.votes_for = proposal
                .votes_for
                .checked_add(power)
                .expect("votes_for overflow");
        } else {
            proposal.votes_against = proposal
                .votes_against
                .checked_add(power)
                .expect("votes_against overflow");
        }
        env.storage().persistent().set(&key, &proposal);
        extend_persistent_ttl(&env, &key);
        env.events().publish(
            (Symbol::new(&env, "vote_cst"), proposal_id, voter),
            (approve, power),
        );
    }

    // ─── Requirement 9: Snapshot → Execution / Defeated ────────────────────

    pub fn finalise_vote(env: Env, proposal_id: u64) {
        let key = DataKey::Proposal(proposal_id);
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        if proposal.stage != ProposalStage::SnapshotVote {
            panic!("invalid stage transition");
        }
        if env.ledger().sequence() <= proposal.vote_end_ledger {
            panic!("voting period not closed");
        }
        let config: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .expect("not initialized");

        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .expect("total votes overflow");

        let approved = total_votes >= config.quorum && proposal.votes_for > proposal.votes_against;

        if approved {
            let current = env.ledger().sequence();
            proposal.stage = ProposalStage::Execution;
            proposal.executable_from_ledger = current
                .checked_add(config.timelock_ledgers)
                .expect("timelock overflow");
            env.storage().persistent().set(&key, &proposal);
            extend_persistent_ttl(&env, &key);
            env.events().publish(
                (Symbol::new(&env, "vote_fnl"), proposal_id),
                (proposal.votes_for, proposal.votes_against),
            );
        } else {
            proposal.stage = ProposalStage::Defeated;
            env.storage().persistent().set(&key, &proposal);
            extend_persistent_ttl(&env, &key);
            env.events().publish(
                (Symbol::new(&env, "prop_dft"), proposal_id),
                (proposal.votes_for, proposal.votes_against),
            );
        }
    }

    // ─── Requirement 10: On-Chain Execution ────────────────────────────────

    pub fn execute_proposal(env: Env, proposal_id: u64) {
        let key = DataKey::Proposal(proposal_id);
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&key)
            .expect("proposal not found");
        if proposal.stage != ProposalStage::Execution {
            panic!("proposal not executable");
        }
        if env.ledger().sequence() < proposal.executable_from_ledger {
            panic!("timelock not elapsed");
        }
        let allow_key =
            DataKey::AllowedTarget(proposal.target_contract.clone(), proposal.function.clone());
        if !env.storage().persistent().has(&allow_key) {
            panic!("target/function not allowlisted");
        }
        let args = vec![&env, proposal.calldata.into_val(&env)];
        env.invoke_contract::<()>(&proposal.target_contract, &proposal.function, args);

        let mut executed = proposal;
        executed.stage = ProposalStage::Executed;
        env.storage().persistent().set(&key, &executed);
        extend_persistent_ttl(&env, &key);
        env.events()
            .publish((Symbol::new(&env, "executed"), proposal_id), ());
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn extend_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, MIN_VOTING_WINDOW, MAX_LOCK_LEDGERS);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger as _},
        token::{self, StellarAssetClient},
        Address, Env,
    };

    const QUORUM: i128 = 1000;
    const VOTING_PERIOD: u32 = 121_000;
    const TIMELOCK: u32 = 10_000;

    #[contract]
    struct Noop;

    #[contractimpl]
    impl Noop {
        pub fn noop(_env: Env, _data: Bytes) {}
    }

    fn deploy_noop(env: &Env) -> Address {
        let addr = env.register_contract(None, Noop);
        env.as_contract(&addr, || {
            env.storage().instance().extend_ttl(1000000, 1000000);
        });
        addr
    }

    fn deploy(env: &Env) -> (Address, Config, DaoGovernanceContractClient<'static>) {
        let admin = Address::generate(env);
        let token_admin = Address::generate(env);
        let token = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();
        env.as_contract(&token, || {
            env.storage().instance().extend_ttl(1000000, 1000000);
        });
        let cid = env.register_contract(None, DaoGovernanceContract);
        let client = DaoGovernanceContractClient::new(env, &cid);
        client.initialize(&token, &QUORUM, &VOTING_PERIOD, &TIMELOCK, &admin);
        let config = Config {
            gp_token: token,
            quorum: QUORUM,
            voting_period_ledgers: VOTING_PERIOD,
            timelock_ledgers: TIMELOCK,
            dao_admin: admin,
        };
        (cid, config, client)
    }

    fn mk_proposal(
        env: &Env,
        client: &DaoGovernanceContractClient<'static>,
        proposer: &Address,
    ) -> u64 {
        let target = Address::generate(env);
        let function = Symbol::new(env, "fn");
        let admin = client.get_config().dao_admin;
        client.add_allowed_target(&admin, &target, &function);
        client.create_proposal(
            proposer,
            &String::from_str(env, "Test"),
            &String::from_str(env, "Desc"),
            &target,
            &function,
            &Bytes::from_slice(env, &[1, 2, 3]),
        )
    }

    fn snapshot(client: &DaoGovernanceContractClient<'static>, caller: &Address, pid: u64) {
        client.advance_to_snapshot(caller, &pid);
    }

    fn vote(
        client: &DaoGovernanceContractClient<'static>,
        voter: &Address,
        pid: u64,
        approve: bool,
    ) {
        client.cast_vote(voter, &pid, &approve);
    }

    fn finalise(client: &DaoGovernanceContractClient<'static>, pid: u64) {
        client.finalise_vote(&pid);
    }

    fn balance_of(env: &Env, token: &Address, who: &Address) -> i128 {
        token::Client::new(env, token).balance(who)
    }

    // ─── R1: Initialisation ───────────────────────────────────────────────

    #[test]
    fn test_init_ok() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let c = client.get_config();
        assert_eq!(c.gp_token, cfg.gp_token);
        assert_eq!(c.quorum, QUORUM);
        assert_eq!(c.voting_period_ledgers, VOTING_PERIOD);
        assert_eq!(c.timelock_ledgers, TIMELOCK);
        assert_eq!(c.dao_admin, cfg.dao_admin);
        assert_eq!(client.get_proposal_count(), 0);
    }

    #[test]
    #[should_panic(expected = "already initialized")]
    fn test_double_init_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let a = Address::generate(&env);
        let ta = Address::generate(&env);
        let t = env.register_stellar_asset_contract_v2(ta).address();
        let cid = env.register_contract(None, DaoGovernanceContract);
        let cl = DaoGovernanceContractClient::new(&env, &cid);
        cl.initialize(&t, &QUORUM, &VOTING_PERIOD, &TIMELOCK, &a);
        cl.initialize(&t, &QUORUM, &VOTING_PERIOD, &TIMELOCK, &a);
    }

    #[test]
    #[should_panic(expected = "quorum must be positive")]
    fn test_init_zero_quorum_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let a = Address::generate(&env);
        let ta = Address::generate(&env);
        let t = env.register_stellar_asset_contract_v2(ta).address();
        let cid = env.register_contract(None, DaoGovernanceContract);
        let cl = DaoGovernanceContractClient::new(&env, &cid);
        cl.initialize(&t, &0i128, &VOTING_PERIOD, &TIMELOCK, &a);
    }

    #[test]
    #[should_panic(expected = "voting period too short")]
    fn test_init_short_voting_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let a = Address::generate(&env);
        let ta = Address::generate(&env);
        let t = env.register_stellar_asset_contract_v2(ta).address();
        let cid = env.register_contract(None, DaoGovernanceContract);
        let cl = DaoGovernanceContractClient::new(&env, &cid);
        cl.initialize(&t, &QUORUM, &(MIN_VOTING_WINDOW - 1), &TIMELOCK, &a);
    }

    #[test]
    #[should_panic(expected = "timelock must be positive")]
    fn test_init_zero_timelock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let a = Address::generate(&env);
        let ta = Address::generate(&env);
        let t = env.register_stellar_asset_contract_v2(ta).address();
        let cid = env.register_contract(None, DaoGovernanceContract);
        let cl = DaoGovernanceContractClient::new(&env, &cid);
        cl.initialize(&t, &QUORUM, &VOTING_PERIOD, &0u32, &a);
    }

    // ─── R2: GP Token Locking ─────────────────────────────────────────────

    #[test]
    fn test_lock_creates_lock() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let voter = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&voter, &5000i128);

        let d = MIN_LOCK_LEDGERS + 1000;
        let start = env.ledger().sequence();
        client.lock_tokens(&voter, &5000i128, &d);

        let lock = client.get_lock(&voter);
        assert_eq!(lock.amount, 5000);
        assert_eq!(lock.unlock_ledger, start + d);
        assert_eq!(lock.created_ledger, start);

        let bal = balance_of(&env, &cfg.gp_token, &_cid);
        assert_eq!(bal, 5000);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_lock_zero_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.lock_tokens(&v, &0i128, &MIN_LOCK_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "amount must be positive")]
    fn test_lock_neg_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.lock_tokens(&v, &(-100i128), &MIN_LOCK_LEDGERS);
    }

    #[test]
    #[should_panic(expected = "lock duration too short")]
    fn test_lock_too_short_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.lock_tokens(&v, &100i128, &(MIN_LOCK_LEDGERS - 1));
    }

    #[test]
    #[should_panic(expected = "lock duration too long")]
    fn test_lock_too_long_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.lock_tokens(&v, &100i128, &(MAX_LOCK_LEDGERS + 1));
    }

    #[test]
    #[should_panic(expected = "existing lock must be extended or expired")]
    fn test_lock_active_exists_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &10000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
    }

    #[test]
    fn test_lock_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &1000i128);
        client.lock_tokens(&v, &1000i128, &MIN_LOCK_LEDGERS);
        let events = env.events().all();
        assert_eq!(events.last().unwrap().0, cid);
    }

    #[test]
    fn test_get_lock_default() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let lock = client.get_lock(&v);
        assert_eq!(lock.amount, 0);
        assert_eq!(lock.unlock_ledger, 0);
        assert_eq!(lock.created_ledger, 0);
    }

    // ─── R3: Lock Extension ───────────────────────────────────────────────

    #[test]
    fn test_extend_ok() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        let before = client.get_lock(&v);
        let nu = before.unlock_ledger + 100_000;
        client.extend_lock(&v, &nu);
        let after = client.get_lock(&v);
        assert_eq!(after.unlock_ledger, nu);
        assert_eq!(after.amount, 5000);
    }

    #[test]
    #[should_panic(expected = "no active lock")]
    fn test_extend_no_lock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        client.extend_lock(&v, &100_000u32);
    }

    #[test]
    #[should_panic(expected = "new unlock must be later")]
    fn test_extend_same_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        let lock = client.get_lock(&v);
        client.extend_lock(&v, &lock.unlock_ledger);
    }

    #[test]
    #[should_panic(expected = "lock duration too long")]
    fn test_extend_beyond_max_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        let max = env.ledger().sequence() + MAX_LOCK_LEDGERS;
        client.extend_lock(&v, &(max + 1));
    }

    // ─── R4: Token Withdrawal ─────────────────────────────────────────────

    #[test]
    fn test_withdraw_after_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);

        let bal_before = balance_of(&env, &cfg.gp_token, &v);
        let short = MIN_LOCK_LEDGERS;
        client.lock_tokens(&v, &5000i128, &short);

        assert_eq!(balance_of(&env, &cfg.gp_token, &cid), 5000);

        env.ledger()
            .set_sequence_number(env.ledger().sequence() + short + 1);
        client.withdraw(&v);

        assert_eq!(balance_of(&env, &cfg.gp_token, &v), bal_before);
        assert_eq!(client.get_lock(&v).amount, 0);
    }

    #[test]
    #[should_panic(expected = "no lock found")]
    fn test_withdraw_no_lock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        client.withdraw(&Address::generate(&env));
    }

    #[test]
    #[should_panic(expected = "lock not yet expired")]
    fn test_withdraw_before_expiry_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &5000i128);
        client.lock_tokens(&v, &5000i128, &MIN_LOCK_LEDGERS);
        client.withdraw(&v);
    }

    // ─── R5: Voting Power ─────────────────────────────────────────────────

    #[test]
    fn test_vp_scales_with_time() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v1 = Address::generate(&env);
        let v2 = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v1, &500_000i128);
        sac.mint(&v2, &500_000i128);
        client.lock_tokens(&v1, &1000i128, &MIN_LOCK_LEDGERS);
        client.lock_tokens(&v2, &1000i128, &MAX_LOCK_LEDGERS);
        let cur = env.ledger().sequence();
        let short = client.get_voting_power(&v1, &cur);
        let long = client.get_voting_power(&v2, &cur);
        assert!(long > short);
    }

    #[test]
    fn test_vp_zero_after_expiry() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &1000i128);
        client.lock_tokens(&v, &1000i128, &MIN_LOCK_LEDGERS);
        let after = env.ledger().sequence() + MIN_LOCK_LEDGERS + 1;
        assert_eq!(client.get_voting_power(&v, &after), 0);
    }

    #[test]
    fn test_vp_positive_at_creation() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &1000i128);
        client.lock_tokens(&v, &1000i128, &MAX_LOCK_LEDGERS);
        assert!(client.get_voting_power(&v, &env.ledger().sequence()) > 0);
    }

    #[test]
    fn test_vp_zero_no_lock() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        assert_eq!(
            client.get_voting_power(&Address::generate(&env), &100u32),
            0
        );
    }

    #[test]
    fn test_snapshot_power_matches_vp_at_snapshot() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let cur = env.ledger().sequence();
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &v, pid, true);

        let expected = client.get_voting_power(&v, &cur);
        assert_eq!(client.get_snapshot_power(&v, &pid), expected);
    }

    // ─── R6: Proposal Creation ────────────────────────────────────────────

    #[test]
    fn test_create_proposal() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &v);
        assert_eq!(pid, 1);
        let p = client.get_proposal(&pid);
        assert_eq!(p.stage, ProposalStage::Discussion);
        assert_eq!(p.votes_for, 0);
        assert_eq!(p.votes_against, 0);
    }

    #[test]
    fn test_proposal_ids_increment() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        assert_eq!(mk_proposal(&env, &client, &v), 1);
        assert_eq!(mk_proposal(&env, &client, &v), 2);
        assert_eq!(client.get_proposal_count(), 2);
    }

    #[test]
    #[should_panic(expected = "insufficient voting power to propose")]
    fn test_create_no_power_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        mk_proposal(&env, &client, &Address::generate(&env));
    }

    // ─── R7: Discussion → Snapshot ────────────────────────────────────────

    #[test]
    fn test_advance_by_proposer() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &v);
        let cur = env.ledger().sequence();
        snapshot(&client, &v, pid);

        let p = client.get_proposal(&pid);
        assert_eq!(p.stage, ProposalStage::SnapshotVote);
        assert_eq!(p.snapshot_ledger, cur);
        assert_eq!(p.vote_end_ledger, cur + VOTING_PERIOD);
    }

    #[test]
    fn test_advance_by_admin() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &cfg.dao_admin, pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::SnapshotVote);
    }

    #[test]
    #[should_panic(expected = "invalid stage transition")]
    fn test_advance_from_wrong_stage_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        snapshot(&client, &v, pid);
    }

    #[test]
    #[should_panic(expected = "not authorised to advance proposal")]
    fn test_advance_by_rando_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &Address::generate(&env), pid);
    }

    // ─── R8: Snapshotted Voting ───────────────────────────────────────────

    #[test]
    fn test_vote_for() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &v, pid, true);
        let p = client.get_proposal(&pid);
        assert!(p.votes_for > 0);
        assert_eq!(p.votes_against, 0);
    }

    #[test]
    fn test_vote_against() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &v, pid, false);
        let p = client.get_proposal(&pid);
        assert_eq!(p.votes_for, 0);
        assert!(p.votes_against > 0);
    }

    #[test]
    #[should_panic(expected = "voting not active")]
    fn test_vote_in_discussion_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        vote(&client, &v, mk_proposal(&env, &client, &v), true);
    }

    #[test]
    #[should_panic(expected = "already voted")]
    fn test_double_vote_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &v, pid, true);
        vote(&client, &v, pid, false);
    }

    #[test]
    #[should_panic(expected = "no voting power at snapshot")]
    fn test_vote_no_power_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        vote(&client, &Address::generate(&env), pid, true);
    }

    #[test]
    fn test_vote_power_frozen_at_snapshot() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &(MAX_LOCK_LEDGERS as i128));
        let max = MAX_LOCK_LEDGERS as i128;
        client.lock_tokens(&v, &max, &MAX_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &v);
        let snap_ledger = env.ledger().sequence();
        snapshot(&client, &v, pid);
        let snap_power = client.get_voting_power(&v, &snap_ledger);

        env.ledger().set_sequence_number(snap_ledger + 100_000);
        vote(&client, &v, pid, true);

        assert_eq!(client.get_snapshot_power(&v, &pid), snap_power);
    }

    // ─── R9: Snapshot → Execution / Defeated ──────────────────────────────

    #[test]
    fn test_finalise_approves() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        let p = client.get_proposal(&pid);
        assert_eq!(p.stage, ProposalStage::Execution);
        assert!(p.executable_from_ledger > env.ledger().sequence() - TIMELOCK);
    }

    #[test]
    fn test_finalise_defeated_no_quorum() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500i128);
        client.lock_tokens(&a, &500i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::Defeated);
    }

    #[test]
    fn test_finalise_defeated_tie() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &600i128);
        sac.mint(&b, &600i128);
        client.lock_tokens(&a, &600i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &600i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &a);
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, false);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::Defeated);
    }

    #[test]
    #[should_panic(expected = "invalid stage transition")]
    fn test_finalise_discussion_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        finalise(&client, mk_proposal(&env, &client, &v));
    }

    #[test]
    #[should_panic(expected = "voting period not closed")]
    fn test_finalise_before_end_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &v);
        snapshot(&client, &v, pid);
        finalise(&client, pid);
    }

    // ─── R10: On-Chain Execution ──────────────────────────────────────────

    #[test]
    fn test_execute_proposal() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let target = deploy_noop(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        let noop_fn = Symbol::new(&env, "noop");
        client.add_allowed_target(&cfg.dao_admin, &target, &noop_fn);
        let pid = client.create_proposal(
            &a,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "Y"),
            &target,
            &noop_fn,
            &Bytes::new(&env),
        );
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        let p = client.get_proposal(&pid);
        env.ledger().set_sequence_number(p.executable_from_ledger);
        client.execute_proposal(&pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::Executed);
    }

    #[test]
    #[should_panic(expected = "proposal not executable")]
    fn test_execute_non_execution_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);
        client.execute_proposal(&mk_proposal(&env, &client, &v));
    }

    #[test]
    #[should_panic(expected = "timelock not elapsed")]
    fn test_execute_before_timelock_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let target = deploy_noop(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        let noop_fn = Symbol::new(&env, "noop");
        client.add_allowed_target(&cfg.dao_admin, &target, &noop_fn);
        let pid = client.create_proposal(
            &a,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "Y"),
            &target,
            &noop_fn,
            &Bytes::new(&env),
        );
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);
        client.execute_proposal(&pid);
    }

    // ─── R11: Economic Invariants ─────────────────────────────────────────

    #[test]
    fn test_round_trip_conservation() {
        let env = Env::default();
        env.mock_all_auths();
        let (cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &10_000i128);

        let bal_before = balance_of(&env, &cfg.gp_token, &v);
        client.lock_tokens(&v, &10_000i128, &MIN_LOCK_LEDGERS);
        assert_eq!(balance_of(&env, &cfg.gp_token, &v), bal_before - 10_000);
        assert_eq!(balance_of(&env, &cfg.gp_token, &cid), 10_000);

        env.ledger()
            .set_sequence_number(env.ledger().sequence() + MIN_LOCK_LEDGERS + 1);
        client.withdraw(&v);
        assert_eq!(balance_of(&env, &cfg.gp_token, &v), bal_before);
        assert_eq!(balance_of(&env, &cfg.gp_token, &cid), 0);
    }

    #[test]
    fn test_vp_monotonically_decreasing() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        let max = MAX_LOCK_LEDGERS as i128;
        sac.mint(&v, &max);
        client.lock_tokens(&v, &max, &MAX_LOCK_LEDGERS);

        let t1 = env.ledger().sequence();
        let t2 = t1 + 100_000;
        let t3 = t2 + 100_000;
        let p1 = client.get_voting_power(&v, &t1);
        let p2 = client.get_voting_power(&v, &t2);
        let p3 = client.get_voting_power(&v, &t3);
        assert!(p1 > p2 && p2 > p3);
    }

    #[test]
    fn test_snapshot_immutable_after_extend() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        let max = MAX_LOCK_LEDGERS as i128;
        sac.mint(&v, &max);
        client.lock_tokens(&v, &max, &MIN_LOCK_LEDGERS);

        let pid = mk_proposal(&env, &client, &v);
        let snap_ledger = env.ledger().sequence();
        snapshot(&client, &v, pid);

        let lock = client.get_lock(&v);
        client.extend_lock(&v, &(lock.unlock_ledger + 500_000));
        let expected_power = client.get_voting_power(&v, &snap_ledger);

        env.ledger().set_sequence_number(snap_ledger + 100_000);
        vote(&client, &v, pid, true);

        assert_eq!(client.get_snapshot_power(&v, &pid), expected_power);
    }

    // ─── R12: Flash Loan Prevention ───────────────────────────────────────

    #[test]
    fn test_vote_uses_snapshot_ledger() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let p = Address::generate(&env);
        let late = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&p, &500_000i128);
        client.lock_tokens(&p, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &p);
        let snap_ledger = env.ledger().sequence();
        snapshot(&client, &p, pid);

        env.ledger().set_sequence_number(snap_ledger + 5000);
        sac.mint(&late, &500_000i128);
        client.lock_tokens(&late, &500_000i128, &MAX_LOCK_LEDGERS);

        assert_eq!(client.get_voting_power(&late, &snap_ledger), 0);
        assert!(client.get_voting_power(&late, &env.ledger().sequence()) > 0);
    }

    #[test]
    fn test_cannot_vote_without_lock() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let p = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&p, &500_000i128);
        client.lock_tokens(&p, &500_000i128, &MAX_LOCK_LEDGERS);
        let pid = mk_proposal(&env, &client, &p);
        snapshot(&client, &p, pid);
        assert_eq!(
            client.get_voting_power(&Address::generate(&env), &env.ledger().sequence()),
            0
        );
    }

    // ─── R13: Calldata Round-Trip ─────────────────────────────────────────

    #[test]
    fn test_calldata_round_trip() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let target = Address::generate(&env);
        let function = Symbol::new(&env, "f");
        client.add_allowed_target(&cfg.dao_admin, &target, &function);

        let orig = Bytes::from_slice(&env, &[1, 2, 3, 255, 0, 128]);
        let pid = client.create_proposal(
            &v,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &target,
            &function,
            &orig,
        );
        let p = client.get_proposal(&pid);
        assert_eq!(p.calldata, orig);
        assert_eq!(p.calldata.len(), orig.len());
    }

    #[test]
    fn test_empty_calldata_accepted() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let target = Address::generate(&env);
        let function = Symbol::new(&env, "f");
        client.add_allowed_target(&cfg.dao_admin, &target, &function);

        let pid = client.create_proposal(
            &v,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &target,
            &function,
            &Bytes::new(&env),
        );
        assert_eq!(client.get_proposal(&pid).calldata.len(), 0);
    }

    // ─── R14: Access Control ──────────────────────────────────────────────

    #[test]
    fn test_execute_anyone_can_call() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let target = deploy_noop(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        let noop_fn = Symbol::new(&env, "noop");
        client.add_allowed_target(&cfg.dao_admin, &target, &noop_fn);
        let pid = client.create_proposal(
            &a,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "Y"),
            &target,
            &noop_fn,
            &Bytes::new(&env),
        );
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        let p = client.get_proposal(&pid);
        env.ledger().set_sequence_number(p.executable_from_ledger);
        client.execute_proposal(&pid);
        assert_eq!(client.get_proposal(&pid).stage, ProposalStage::Executed);
    }

    // ─── R15: Execution Target Allowlist ──────────────────────────────────

    #[test]
    #[should_panic(expected = "target/function not allowlisted")]
    fn test_create_proposal_rejects_unallowlisted_target() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        client.create_proposal(
            &v,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &Address::generate(&env),
            &Symbol::new(&env, "f"),
            &Bytes::new(&env),
        );
    }

    #[test]
    #[should_panic(expected = "target/function not allowlisted")]
    fn test_create_proposal_rejects_unallowlisted_function() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let v = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&v, &500_000i128);
        client.lock_tokens(&v, &500_000i128, &MAX_LOCK_LEDGERS);

        let target = Address::generate(&env);
        client.add_allowed_target(&cfg.dao_admin, &target, &Symbol::new(&env, "foo"));

        // Same target, different function: allowlisting must be checked as a
        // (target, function) pair, not the target alone.
        client.create_proposal(
            &v,
            &String::from_str(&env, "T"),
            &String::from_str(&env, "D"),
            &target,
            &Symbol::new(&env, "bar"),
            &Bytes::new(&env),
        );
    }

    #[test]
    fn test_allowed_target_add_and_remove_persist() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "f");

        assert!(!client.is_allowed_target(&target, &function));
        client.add_allowed_target(&cfg.dao_admin, &target, &function);
        assert!(client.is_allowed_target(&target, &function));
        client.remove_allowed_target(&cfg.dao_admin, &target, &function);
        assert!(!client.is_allowed_target(&target, &function));
    }

    #[test]
    #[should_panic(expected = "not authorised to modify allowlist")]
    fn test_add_allowed_target_unauthorized_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, _cfg, client) = deploy(&env);
        let rando = Address::generate(&env);
        client.add_allowed_target(&rando, &Address::generate(&env), &Symbol::new(&env, "f"));
    }

    #[test]
    #[should_panic(expected = "not authorised to modify allowlist")]
    fn test_remove_allowed_target_unauthorized_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let target = Address::generate(&env);
        let function = Symbol::new(&env, "f");
        client.add_allowed_target(&cfg.dao_admin, &target, &function);

        let rando = Address::generate(&env);
        client.remove_allowed_target(&rando, &target, &function);
    }

    #[test]
    #[should_panic(expected = "target/function not allowlisted")]
    fn test_removed_target_cannot_execute() {
        let env = Env::default();
        env.mock_all_auths();
        let (_cid, cfg, client) = deploy(&env);
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let target = deploy_noop(&env);
        let function = Symbol::new(&env, "noop");
        let sac = StellarAssetClient::new(&env, &cfg.gp_token);
        sac.mint(&a, &500_000i128);
        sac.mint(&b, &500_000i128);
        client.lock_tokens(&a, &500_000i128, &MAX_LOCK_LEDGERS);
        client.lock_tokens(&b, &500_000i128, &MAX_LOCK_LEDGERS);

        client.add_allowed_target(&cfg.dao_admin, &target, &function);
        let pid = client.create_proposal(
            &a,
            &String::from_str(&env, "X"),
            &String::from_str(&env, "Y"),
            &target,
            &function,
            &Bytes::new(&env),
        );
        snapshot(&client, &a, pid);
        let end = env.ledger().sequence() + VOTING_PERIOD;
        vote(&client, &a, pid, true);
        vote(&client, &b, pid, true);
        env.ledger().set_sequence_number(end + 1);
        finalise(&client, pid);

        // Allowlist entry is revoked while the proposal sits in its timelock;
        // execution must re-check the allowlist, not just trust the pair
        // that was valid at proposal-creation time.
        client.remove_allowed_target(&cfg.dao_admin, &target, &function);

        let p = client.get_proposal(&pid);
        env.ledger().set_sequence_number(p.executable_from_ledger);
        client.execute_proposal(&pid);
    }
}
