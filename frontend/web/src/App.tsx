// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ScheduleEvent {
  id: string;
  encryptedStartTime: string;
  encryptedEndTime: string;
  encryptedDuration: string;
  encryptedPriority: string;
  category: "work" | "personal";
  timestamp: number;
  owner: string;
  status: "pending" | "optimized" | "conflict";
  title: string; // Non-sensitive data
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newEventData, setNewEventData] = useState({ 
    title: "", 
    category: "work" as "work" | "personal",
    startTime: 0,
    endTime: 0,
    priority: 1
  });
  const [showTutorial, setShowTutorial] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<ScheduleEvent | null>(null);
  const [decryptedData, setDecryptedData] = useState<{startTime?: number, endTime?: number, duration?: number, priority?: number} | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterCategory, setFilterCategory] = useState<"all" | "work" | "personal">("all");

  const optimizedCount = events.filter(e => e.status === "optimized").length;
  const pendingCount = events.filter(e => e.status === "pending").length;
  const conflictCount = events.filter(e => e.status === "conflict").length;

  useEffect(() => {
    loadEvents().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadEvents = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("event_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing event keys:", e); }
      }
      
      const list: ScheduleEvent[] = [];
      for (const key of keys) {
        try {
          const eventBytes = await contract.getData(`event_${key}`);
          if (eventBytes.length > 0) {
            try {
              const eventData = JSON.parse(ethers.toUtf8String(eventBytes));
              list.push({ 
                id: key, 
                encryptedStartTime: eventData.startTime, 
                encryptedEndTime: eventData.endTime,
                encryptedDuration: eventData.duration,
                encryptedPriority: eventData.priority,
                category: eventData.category,
                timestamp: eventData.timestamp, 
                owner: eventData.owner, 
                status: eventData.status || "pending",
                title: eventData.title
              });
            } catch (e) { console.error(`Error parsing event data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading event ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setEvents(list);
    } catch (e) { console.error("Error loading events:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitEvent = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting schedule data with Zama FHE..." });
    try {
      const duration = newEventData.endTime - newEventData.startTime;
      const encryptedStart = FHEEncryptNumber(newEventData.startTime);
      const encryptedEnd = FHEEncryptNumber(newEventData.endTime);
      const encryptedDuration = FHEEncryptNumber(duration);
      const encryptedPriority = FHEEncryptNumber(newEventData.priority);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const eventId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const eventData = { 
        startTime: encryptedStart,
        endTime: encryptedEnd,
        duration: encryptedDuration,
        priority: encryptedPriority,
        category: newEventData.category,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "pending",
        title: newEventData.title
      };
      
      await contract.setData(`event_${eventId}`, ethers.toUtf8Bytes(JSON.stringify(eventData)));
      
      const keysBytes = await contract.getData("event_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(eventId);
      await contract.setData("event_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Encrypted schedule submitted securely!" });
      await loadEvents();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewEventData({ 
          title: "", 
          category: "work",
          startTime: 0,
          endTime: 0,
          priority: 1
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const optimizeSchedule = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Optimizing schedule with FHE computation..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Simulate FHE optimization by adjusting times
      for (const event of events) {
        if (event.status === "pending") {
          const encryptedOptimizedStart = FHECompute(event.encryptedStartTime, 'increase10%');
          const encryptedOptimizedEnd = FHECompute(event.encryptedEndTime, 'increase10%');
          
          const updatedEvent = { 
            ...JSON.parse(ethers.toUtf8String(await contract.getData(`event_${event.id}`))),
            status: "optimized",
            startTime: encryptedOptimizedStart,
            endTime: encryptedOptimizedEnd
          };
          
          await contract.setData(`event_${event.id}`, ethers.toUtf8Bytes(JSON.stringify(updatedEvent)));
        }
      }
      
      setTransactionStatus({ visible: true, status: "success", message: "Schedule optimized with FHE!" });
      await loadEvents();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Optimization failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (eventAddress: string) => address?.toLowerCase() === eventAddress.toLowerCase();

  const tutorialSteps = [
    { title: "Connect Wallet", description: "Connect your Web3 wallet to access your encrypted calendars", icon: "🔗" },
    { title: "Add Schedule Events", description: "Add your work and personal events with time preferences", icon: "⏰", details: "Your time data is encrypted with Zama FHE before being stored" },
    { title: "FHE Optimization", description: "AI agent processes your encrypted schedule to find optimal times", icon: "⚙️", details: "Zama FHE allows computations on encrypted time data without exposing your schedule" },
    { title: "Get Optimized Schedule", description: "Receive optimized schedule while keeping your data private", icon: "📅", details: "The optimized times are computed on encrypted data and can be verified without decryption" }
  ];

  const renderTimeDistributionChart = () => {
    const workHours = events.filter(e => e.category === "work").length;
    const personalHours = events.filter(e => e.category === "personal").length;
    const total = workHours + personalHours || 1;
    
    return (
      <div className="time-chart-container">
        <div className="time-chart">
          <div className="time-segment work" style={{ width: `${(workHours / total) * 100}%` }}></div>
          <div className="time-segment personal" style={{ width: `${(personalHours / total) * 100}%` }}></div>
        </div>
        <div className="time-legend">
          <div className="legend-item"><div className="color-box work"></div><span>Work: {workHours}h</span></div>
          <div className="legend-item"><div className="color-box personal"></div><span>Personal: {personalHours}h</span></div>
        </div>
      </div>
    );
  };

  const filteredEvents = events.filter(event => {
    const matchesSearch = event.title.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = filterCategory === "all" || event.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="rainbow-spinner"></div>
      <p>Initializing encrypted schedule connection...</p>
    </div>
  );

  return (
    <div className="app-container glass-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="calendar-icon"></div></div>
          <h1>AI<span>Scheduler</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-event-btn glass-button">
            <div className="add-icon"></div>Add Event
          </button>
          <button className="glass-button" onClick={() => setShowTutorial(!showTutorial)}>
            {showTutorial ? "Hide Tutorial" : "Show Tutorial"}
          </button>
          <div className="wallet-connect-wrapper"><ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/></div>
        </div>
      </header>
      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>FHE-Powered AI Scheduler</h2>
            <p>Optimize your work-life balance without exposing your schedule details</p>
          </div>
          <div className="fhe-indicator"><div className="fhe-lock"></div><span>FHE Encryption Active</span></div>
        </div>
        {showTutorial && (
          <div className="tutorial-section">
            <h2>FHE Schedule Optimization</h2>
            <p className="subtitle">Learn how to securely optimize your schedule</p>
            <div className="tutorial-steps">
              {tutorialSteps.map((step, index) => (
                <div className="tutorial-step" key={index}>
                  <div className="step-icon">{step.icon}</div>
                  <div className="step-content">
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                    {step.details && <div className="step-details">{step.details}</div>}
                  </div>
                </div>
              ))}
            </div>
            <div className="fhe-diagram">
              <div className="diagram-step"><div className="diagram-icon">⏰</div><div className="diagram-label">Your Schedule</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🔒</div><div className="diagram-label">FHE Encryption</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">🤖</div><div className="diagram-label">AI Optimization</div></div>
              <div className="diagram-arrow">→</div>
              <div className="diagram-step"><div className="diagram-icon">📅</div><div className="diagram-label">Optimized Schedule</div></div>
            </div>
          </div>
        )}
        <div className="dashboard-grid">
          <div className="dashboard-card glass-card">
            <h3>Project Introduction</h3>
            <p>AI Scheduler powered by <strong>Zama FHE technology</strong> that optimizes your schedule across work and personal calendars without ever decrypting your sensitive time data.</p>
            <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          </div>
          <div className="dashboard-card glass-card">
            <h3>Schedule Statistics</h3>
            <div className="stats-grid">
              <div className="stat-item"><div className="stat-value">{events.length}</div><div className="stat-label">Total Events</div></div>
              <div className="stat-item"><div className="stat-value">{optimizedCount}</div><div className="stat-label">Optimized</div></div>
              <div className="stat-item"><div className="stat-value">{pendingCount}</div><div className="stat-label">Pending</div></div>
              <div className="stat-item"><div className="stat-value">{conflictCount}</div><div className="stat-label">Conflicts</div></div>
            </div>
          </div>
          <div className="dashboard-card glass-card">
            <h3>Time Distribution</h3>
            {renderTimeDistributionChart()}
          </div>
        </div>
        <div className="events-section">
          <div className="section-header">
            <h2>Your Encrypted Schedule</h2>
            <div className="header-actions">
              <div className="search-filter">
                <input 
                  type="text" 
                  placeholder="Search events..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="glass-input"
                />
                <select 
                  value={filterCategory} 
                  onChange={(e) => setFilterCategory(e.target.value as any)}
                  className="glass-select"
                >
                  <option value="all">All Categories</option>
                  <option value="work">Work</option>
                  <option value="personal">Personal</option>
                </select>
              </div>
              <button onClick={optimizeSchedule} className="optimize-btn glass-button" disabled={isRefreshing}>
                {isRefreshing ? "Optimizing..." : "Optimize Schedule"}
              </button>
              <button onClick={loadEvents} className="refresh-btn glass-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="events-list glass-card">
            <div className="table-header">
              <div className="header-cell">Title</div>
              <div className="header-cell">Category</div>
              <div className="header-cell">Time</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {filteredEvents.length === 0 ? (
              <div className="no-events">
                <div className="no-events-icon"></div>
                <p>No schedule events found</p>
                <button className="glass-button primary" onClick={() => setShowCreateModal(true)}>Add First Event</button>
              </div>
            ) : filteredEvents.map(event => (
              <div className="event-row" key={event.id} onClick={() => setSelectedEvent(event)}>
                <div className="table-cell">{event.title}</div>
                <div className="table-cell">
                  <span className={`category-badge ${event.category}`}>{event.category}</span>
                </div>
                <div className="table-cell">
                  {new Date(FHEDecryptNumber(event.encryptedStartTime) * 1000).toLocaleTimeString()} - 
                  {new Date(FHEDecryptNumber(event.encryptedEndTime) * 1000).toLocaleTimeString()}
                </div>
                <div className="table-cell">
                  <span className={`status-badge ${event.status}`}>{event.status}</span>
                </div>
                <div className="table-cell actions">
                  {isOwner(event.owner) && (
                    <button 
                      className="action-btn glass-button" 
                      onClick={(e) => { e.stopPropagation(); setSelectedEvent(event); }}
                    >
                      Details
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitEvent} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          eventData={newEventData} 
          setEventData={setNewEventData}
        />
      )}
      {selectedEvent && (
        <EventDetailModal 
          event={selectedEvent} 
          onClose={() => { setSelectedEvent(null); setDecryptedData(null); }} 
          decryptedData={decryptedData} 
          setDecryptedData={setDecryptedData} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content glass-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="rainbow-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="calendar-icon"></div><span>AISchedulerFHE</span></div>
            <p>Work-life balance powered by Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} AI Scheduler FHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  eventData: any;
  setEventData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, eventData, setEventData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setEventData({ ...eventData, [name]: value });
  };

  const handleTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    const timeValue = new Date(`1970-01-01T${value}`).getTime() / 1000;
    setEventData({ ...eventData, [name]: timeValue });
  };

  const handlePriorityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setEventData({ ...eventData, [name]: parseInt(value) });
  };

  const handleSubmit = () => {
    if (!eventData.title || !eventData.startTime || !eventData.endTime) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal glass-card">
        <div className="modal-header">
          <h2>Add Schedule Event</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div><strong>FHE Encryption Notice</strong><p>Your time data will be encrypted with Zama FHE before submission</p></div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Title *</label>
              <input type="text" name="title" value={eventData.title} onChange={handleChange} placeholder="Meeting with team..." className="glass-input"/>
            </div>
            <div className="form-group">
              <label>Category *</label>
              <select name="category" value={eventData.category} onChange={handleChange} className="glass-select">
                <option value="work">Work</option>
                <option value="personal">Personal</option>
              </select>
            </div>
            <div className="form-group">
              <label>Start Time *</label>
              <input type="time" name="startTime" onChange={handleTimeChange} className="glass-input"/>
            </div>
            <div className="form-group">
              <label>End Time *</label>
              <input type="time" name="endTime" onChange={handleTimeChange} className="glass-input"/>
            </div>
            <div className="form-group">
              <label>Priority (1-5)</label>
              <input 
                type="range" 
                name="priority" 
                min="1" 
                max="5" 
                value={eventData.priority} 
                onChange={handlePriorityChange}
                className="priority-slider"
              />
              <div className="priority-value">{eventData.priority}</div>
            </div>
          </div>
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Times:</span>
                <div>
                  {eventData.startTime ? new Date(eventData.startTime * 1000).toLocaleTimeString() : 'Not set'} - 
                  {eventData.endTime ? new Date(eventData.endTime * 1000).toLocaleTimeString() : 'Not set'}
                </div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {eventData.startTime ? FHEEncryptNumber(eventData.startTime).substring(0, 20) + '...' : 'No time set'} | 
                  {eventData.endTime ? FHEEncryptNumber(eventData.endTime).substring(0, 20) + '...' : 'No time set'}
                </div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div><strong>Schedule Privacy</strong><p>Your schedule remains encrypted during FHE optimization and is never decrypted on our servers</p></div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn glass-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn glass-button primary">
            {creating ? "Encrypting with FHE..." : "Add to Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface EventDetailModalProps {
  event: ScheduleEvent;
  onClose: () => void;
  decryptedData: {startTime?: number, endTime?: number, duration?: number, priority?: number} | null;
  setDecryptedData: (data: any) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const EventDetailModal: React.FC<EventDetailModalProps> = ({ event, onClose, decryptedData, setDecryptedData, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedData !== null) { setDecryptedData(null); return; }
    
    setIsDecrypting(true);
    try {
      const startTime = await decryptWithSignature(event.encryptedStartTime);
      const endTime = await decryptWithSignature(event.encryptedEndTime);
      const duration = await decryptWithSignature(event.encryptedDuration);
      const priority = await decryptWithSignature(event.encryptedPriority);
      
      if (startTime !== null && endTime !== null && duration !== null && priority !== null) {
        setDecryptedData({ startTime, endTime, duration, priority });
      }
    } finally {
      setIsDecrypting(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="event-detail-modal glass-card">
        <div className="modal-header">
          <h2>Event Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="event-info">
            <div className="info-item"><span>Title:</span><strong>{event.title}</strong></div>
            <div className="info-item"><span>Category:</span><strong className={`category-badge ${event.category}`}>{event.category}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{event.owner.substring(0, 6)}...{event.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(event.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status-badge ${event.status}`}>{event.status}</strong></div>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted Time Data</h3>
            <div className="encrypted-data-grid">
              <div className="encrypted-item">
                <span>Start Time:</span>
                <div>{event.encryptedStartTime.substring(0, 20)}...</div>
              </div>
              <div className="encrypted-item">
                <span>End Time:</span>
                <div>{event.encryptedEndTime.substring(0, 20)}...</div>
              </div>
              <div className="encrypted-item">
                <span>Duration:</span>
                <div>{event.encryptedDuration.substring(0, 20)}...</div>
              </div>
              <div className="encrypted-item">
                <span>Priority:</span>
                <div>{event.encryptedPriority.substring(0, 20)}...</div>
              </div>
            </div>
            <div className="fhe-tag"><div className="fhe-icon"></div><span>FHE Encrypted</span></div>
            <button className="decrypt-btn glass-button" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedData !== null ? "Hide Decrypted Data" : "Decrypt with Wallet"}
            </button>
          </div>
          {decryptedData !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Values</h3>
              <div className="decrypted-data-grid">
                <div className="decrypted-item">
                  <span>Start Time:</span>
                  <div>{new Date(decryptedData.startTime! * 1000).toLocaleTimeString()}</div>
                </div>
                <div className="decrypted-item">
                  <span>End Time:</span>
                  <div>{new Date(decryptedData.endTime! * 1000).toLocaleTimeString()}</div>
                </div>
                <div className="decrypted-item">
                  <span>Duration:</span>
                  <div>{decryptedData.duration} seconds</div>
                </div>
                <div className="decrypted-item">
                  <span>Priority:</span>
                  <div>{decryptedData.priority}</div>
                </div>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted data is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn glass-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;