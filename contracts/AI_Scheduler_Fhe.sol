pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract AISchedulerFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    bool public batchOpen;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    // Encrypted data storage
    // For simplicity, this example stores aggregated scores per batch.
    // A real application would store more granular encrypted calendar data.
    euint32 public encryptedOptimalWorkTimeScore;
    euint32 public encryptedOptimalPersonalTimeScore;
    euint32 public encryptedOverallBalanceScore;

    // Events
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event BatchOpened(uint256 batchId);
    event BatchClosed(uint256 batchId);
    event DataSubmitted(address indexed provider, uint256 batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 batchId, uint256 optimalWorkTimeScore, uint256 optimalPersonalTimeScore, uint256 overallBalanceScore);

    // Custom Errors
    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error InvalidBatchId();
    error ReplayAttempt();
    error StateMismatch();
    error DecryptionFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true; // Owner is also a provider by default
        emit ProviderAdded(owner);
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused != paused) {
            paused = _paused;
            if (paused) {
                emit ContractPaused(msg.sender);
            } else {
                emit ContractUnpaused(msg.sender);
            }
        }
    }

    function setCooldownSeconds(uint256 newCooldown) external onlyOwner {
        require(newCooldown > 0, "Cooldown must be positive");
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = newCooldown;
        emit CooldownSecondsUpdated(oldCooldown, newCooldown);
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        batchOpen = true;
        // Initialize encrypted state for the new batch
        encryptedOptimalWorkTimeScore = FHE.asEuint32(0);
        encryptedOptimalPersonalTimeScore = FHE.asEuint32(0);
        encryptedOverallBalanceScore = FHE.asEuint32(0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batchOpen) revert BatchNotOpen();
        batchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEncryptedScheduleData(
        euint32 encryptedWorkScore,
        euint32 encryptedPersonalScore
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!batchOpen) revert BatchNotOpen();

        lastSubmissionTime[msg.sender] = block.timestamp;

        // Aggregate scores (example logic)
        // In a real system, this would be more complex AI logic
        encryptedOptimalWorkTimeScore = encryptedOptimalWorkTimeScore.add(encryptedWorkScore);
        encryptedOptimalPersonalTimeScore = encryptedOptimalPersonalTimeScore.add(encryptedPersonalScore);

        // Example: overall balance is sum of work and personal scores
        encryptedOverallBalanceScore = encryptedOptimalWorkTimeScore.add(encryptedOptimalPersonalTimeScore);

        emit DataSubmitted(msg.sender, currentBatchId);
    }

    function requestOptimalScheduleDecryption() external onlyProvider whenNotPaused checkDecryptionCooldown {
        if (!batchOpen) revert BatchNotOpen(); // Ensure batch is still open for processing

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        // 1. Prepare Ciphertexts
        // Order: optimalWorkTimeScore, optimalPersonalTimeScore, overallBalanceScore
        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(encryptedOptimalWorkTimeScore);
        cts[1] = FHE.toBytes32(encryptedOptimalPersonalTimeScore);
        cts[2] = FHE.toBytes32(encryptedOverallBalanceScore);

        // 2. Compute State Hash
        bytes32 stateHash = _hashCiphertexts(cts);

        // 3. Request Decryption
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        // 4. Store Context
        decryptionContexts[requestId] = DecryptionContext({
            batchId: currentBatchId,
            stateHash: stateHash,
            processed: false
        });

        emit DecryptionRequested(requestId, currentBatchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        // 5a. Replay Guard
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        // 5b. State Verification
        // Rebuild cts in the exact same order as in requestOptimalScheduleDecryption
        bytes32[] memory currentCts = new bytes32[](3);
        currentCts[0] = FHE.toBytes32(encryptedOptimalWorkTimeScore);
        currentCts[1] = FHE.toBytes32(encryptedOptimalPersonalTimeScore);
        currentCts[2] = FHE.toBytes32(encryptedOverallBalanceScore);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }
        // Security Note: State hash verification ensures that the contract's state
        // (specifically, the ciphertexts being decrypted) has not changed since
        // the decryption was requested. This prevents scenarios where an attacker
        // might alter the data after a request but before decryption.

        // 5c. Proof Verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert DecryptionFailed();
        }

        // 5d. Decode & Finalize
        // Decode cleartexts in the same order they were provided
        uint256 optimalWorkTimeScore = abi.decode(cleartexts, (uint256));
        cleartexts = cleartexts[32:]; // Advance pointer
        uint256 optimalPersonalTimeScore = abi.decode(cleartexts, (uint256));
        cleartexts = cleartexts[32:]; // Advance pointer
        uint256 overallBalanceScore = abi.decode(cleartexts, (uint256));
        // _useCleartexts(optimalWorkTimeScore, optimalPersonalTimeScore, overallBalanceScore); // Example

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, optimalWorkTimeScore, optimalPersonalTimeScore, overallBalanceScore);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    // Example of a helper to use decrypted data (not strictly required by prompt for this contract)
    // function _useCleartexts(uint256 workScore, uint256 personalScore, uint256 balanceScore) internal {
    //     // Logic to use the decrypted scores, e.g., update user interface,
    //     // trigger other actions, or store for reporting.
    //     // This part is highly application-specific.
    // }
}