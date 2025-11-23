// ==========================================
// 1. IMPORTS & CONFIGURATION
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { 
    getAuth, 
    onAuthStateChanged, 
    createUserWithEmailAndPassword, 
    signInWithEmailAndPassword, 
    signOut 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { 
    getDatabase, 
    ref, 
    set, 
    get, 
    update, 
    onValue, 
    push, 
    child, 
    remove, 
    query, 
    orderByChild, 
    equalTo 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-database.js";

// ==========================================
// REPLACE WITH YOUR FIREBASE CONFIG
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyBw9fuKvHh7R_NvNIfoJOHpRe8bKo78il8", 
    authDomain: "ai-dropout-system.firebaseapp.com",
    databaseURL: "https://ai-dropout-system-default-rtdb.firebaseio.com/",
    projectId: "ai-dropout-system",
    storageBucket: "ai-dropout-system.appspot.com",
    messagingSenderId: "213229509583",
    appId: "1:213229509583:web:e4ec64bd2bb23df0d650ba"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// ==========================================
// 2. GLOBAL STATE & RISK ENGINE
// ==========================================
const AppState = {
    activeUser: null,
    students: {},
    forumPosts: [],
    selectedStudentId: null,
    unsubscribeStudents: null, 
    unsubscribeForum: null,
    html5QrCode: null,
};

// API Helper for Python Backend
async function fetchRiskAssessment(student, sentimentScore) {
    try {
        const response = await fetch('http://localhost:5000/predict_risk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...student,
                sentiment_score: sentimentScore
            })
        });
        if (!response.ok) throw new Error("API Error");
        return await response.json();
    } catch (error) {
        console.error("Risk Assessment Error:", error);
        // Fallback to 0 risk if API fails, to prevent UI crash
        return { risk_score: 0, explanation: [] };
    }
}

class RiskEngine {
    constructor() {
        this.negativeWords = ['bad', 'fail', 'hard', 'quit', 'stress', 'depressed', 'hate', 'worry', 'trouble', 'struggle'];
    }
    
    // We still calculate sentiment locally to feed into the Python Model
    analyzeSentiment(posts) {
        if (!posts || posts.length === 0) return 0;
        let score = 0;
        posts.forEach(p => {
            const text = p.content ? p.content.toLowerCase() : "";
            this.negativeWords.forEach(w => { if(text.includes(w)) score -= 1; });
        });
        return score;
    }
}
const riskEngine = new RiskEngine();

// ==========================================
// 3. AUTHENTICATION & ROUTING
// ==========================================

// Monitor Auth State
onAuthStateChanged(auth, user => {
    if (user && user.email) {
        AppState.activeUser = user;
        document.getElementById('login-screen').classList.add('hidden');
        
        if (user.email.includes('@counselor.com') || user.email.includes('@college.edu')) {
            document.getElementById('counselor-dashboard').classList.remove('hidden');
            setupCounselorDashboard();
        } else {
            document.getElementById('student-dashboard').classList.remove('hidden');
            renderStudentDashboard(user.uid);
        }
    } else {
        AppState.activeUser = null;
        document.getElementById('counselor-dashboard').classList.add('hidden');
        document.getElementById('student-dashboard').classList.add('hidden');
        document.getElementById('login-screen').classList.remove('hidden');
        
        // Reset views
        document.getElementById('portal-initial-view').classList.remove('hidden');
        document.getElementById('counselor-login-view').classList.add('hidden');
        document.getElementById('student-login-view').classList.add('hidden');
        
        const errStudent = document.getElementById('login-error-student');
        const errCounselor = document.getElementById('login-error-counselor');
        if(errStudent) errStudent.classList.add('hidden');
        if(errCounselor) errCounselor.classList.add('hidden');
    }
});

window.handleLogout = () => signOut(auth);

// Handle Login/Signup Form Submission
const counselorForm = document.getElementById('counselor-login-form');
const studentForm = document.getElementById('student-login-form');

if (counselorForm) {
    counselorForm.onsubmit = (e) => { e.preventDefault(); handleAuth(e, 'counselor'); };
}
if (studentForm) {
    studentForm.onsubmit = (e) => { e.preventDefault(); handleAuth(e, 'student'); };
}

function handleAuth(e, role) {
    const errorDiv = document.getElementById(`login-error-${role}`);
    if(errorDiv) errorDiv.classList.add('hidden');

    let emailInput, passwordInput;
    if (role === 'student') {
        emailInput = document.getElementById('student-email');
        passwordInput = document.getElementById('student-password');
    } else {
        emailInput = document.getElementById('counselor-username');
        passwordInput = document.getElementById('counselor-password');
    }

    if (!emailInput || !passwordInput) return;

    const email = emailInput.value.trim();
    const pass = passwordInput.value.trim();
    
    console.log(`Auth Action: ${role} - ${email}`);

    const activeView = document.getElementById(`${role}-login-view`);
    const isRegister = activeView.querySelector('.auth-mode-toggle')?.checked;
    
    // BRANCHING LOGIC
    if (isRegister) {
        if (role === 'student') {
            checkAndRegisterStudentRTDB(email, pass);
        } else if (role === 'counselor') {
            checkAndRegisterCounselorRTDB(email, pass);
        }
    } else {
        signInWithEmailAndPassword(auth, email, pass)
            .then((cred) => console.log("Logged in:", cred.user.uid))
            .catch(err => {
                if(errorDiv) {
                    errorDiv.textContent = "Login Failed: " + err.message;
                    errorDiv.classList.remove('hidden');
                }
            });
    }
}

// --- STUDENT PRE-REG SIGNUP ---
async function checkAndRegisterStudentRTDB(email, password) {
    const errorDiv = document.getElementById('login-error-student');
    
    try {
        const rootRef = ref(db, '/');
        const emailQuery = query(rootRef, orderByChild('emailid'), equalTo(email));
        
        const snapshot = await get(emailQuery);

        if (!snapshot.exists()) {
            errorDiv.textContent = "You are not pre-registered in the system. Please contact your college.";
            errorDiv.classList.remove('hidden');
            return;
        }

        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        let preRegKey = null;
        let studentData = null;
        
        snapshot.forEach((childSnapshot) => {
            preRegKey = childSnapshot.key;
            studentData = childSnapshot.val();
        });

        // Move data from pre-reg ID to UID
        await set(ref(db, user.uid), {
            ...studentData,
            uid: user.uid
        });
        
        // Remove the old numeric key from root
        if (preRegKey !== user.uid) {
            await remove(ref(db, preRegKey));
        }

        alert("Registration Successful! Welcome to Sentinel.");
        
    } catch (error) {
        console.error("Registration Error:", error);
        errorDiv.textContent = error.message;
        errorDiv.classList.remove('hidden');
    }
}

// --- COUNSELOR PRE-REG SIGNUP ---
async function checkAndRegisterCounselorRTDB(email, password) {
    const errorDiv = document.getElementById('login-error-counselor');
    
    try {
        const counselorsRef = ref(db, 'counselors');
        const emailQuery = query(counselorsRef, orderByChild('emailid'), equalTo(email));
        
        const snapshot = await get(emailQuery);

        if (!snapshot.exists()) {
            errorDiv.textContent = "You are not pre-registered as a Counselor.";
            errorDiv.classList.remove('hidden');
            return;
        }

        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        let preRegKey = null;
        let counselorData = null;
        
        snapshot.forEach((childSnapshot) => {
            preRegKey = childSnapshot.key;
            counselorData = childSnapshot.val();
        });

        const updates = {};
        updates['counselors/' + user.uid] = {
            ...counselorData,
            uid: user.uid,
            role: 'counselor'
        };
        updates['counselors/' + preRegKey] = null;

        await update(ref(db), updates);

        alert("Counselor Registration Successful! Logging you in...");
        
    } catch (error) {
        console.error("Counselor Reg Error:", error);
        if (error.code === 'auth/email-already-in-use') {
            errorDiv.textContent = "Email already registered. Please Login.";
        } else {
            errorDiv.textContent = "Error: " + error.message;
        }
        errorDiv.classList.remove('hidden');
    }
}

// ==========================================
// 4. STUDENT DASHBOARD LOGIC (API INTEGRATED)
// ==========================================
function renderStudentDashboard(uid) {
    console.log("Fetching profile for UID:", uid);
    
    // 1. Try fetching by UID first (Standard)
    const studentRef = ref(db, uid);
    
    onValue(studentRef, async (snapshot) => {
        let s = snapshot.val();

        // 2. FALLBACK: If no data by UID, search by Email
        if (!s && AppState.activeUser && AppState.activeUser.email) {
            console.warn("UID data missing. Searching database by Email...");
            try {
                const rootRef = ref(db, '/');
                const emailQuery = query(rootRef, orderByChild('emailid'), equalTo(AppState.activeUser.email));
                const emailSnapshot = await get(emailQuery);
                
                if (emailSnapshot.exists()) {
                    // Get the first match
                    const matchKey = Object.keys(emailSnapshot.val())[0];
                    s = emailSnapshot.val()[matchKey];
                    console.log("Recovered profile via email match!", s);
                }
            } catch (err) {
                console.error("Fallback search failed:", err);
            }
        }

        if (!s) {
            console.warn("No data found for this user (UID or Email).");
            document.getElementById('student-welcome').textContent = "Welcome (Profile Loading Error)";
            document.getElementById('profile-details').innerHTML = "<p>Error: No student profile found. Please contact admin.</p>";
            return; 
        }
        
        AppState.students[uid] = s;
        
        // Data Fallbacks
        const displayName = s.name || s.Name || 'Student';
        const displayEmail = s.emailid || s.email || s.Email || 'N/A';
        const displayPhone = s.mobileno || s.mobile || s.phone || 'N/A';
        const displayAge = s.age || 'N/A';
        const displayGender = s.gender || 'N/A';
        const displayFather = s.father_name || s.FatherName || 'N/A';
        const displayMother = s.mother_name || s.MotherName || 'N/A';
        const displayParentMobile = s.parent_mobile_number || s.ParentMobile || 'N/A';
        const displayAddress = s.address || 'N/A';
        const displayCourse = s.course_enrollment || s.Course || 'N/A';
        const displayYear = s.year_of_graduation || s.Year || 'N/A';

        // Update Header
        document.getElementById('student-welcome').textContent = `Welcome, ${displayName.split(' ')[0]}`;
        
        // Update Stats
        document.getElementById('attendance-display').textContent = `${s.attendance_percentage || 0}%`;
        document.getElementById('display-gpa').textContent = s.gpa || 0.0;
        
        // Render Profile HTML
        const profileHTML = `
            <div class="profile-group">
                <h3>Personal Info</h3>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                    <div class="profile-item"><label>Name</label><p data-field="name" data-editable="false">${displayName}</p></div>
                    <div class="profile-item"><label>Student ID</label><p>${s.student_id || s.id || ''}</p></div>
                    <div class="profile-item"><label>Email</label><p data-field="emailid" data-editable="true">${displayEmail}</p></div>
                    <div class="profile-item"><label>Mobile</label><p data-field="mobileno" data-editable="true">${displayPhone}</p></div>
                    <div class="profile-item"><label>Age</label><p data-field="age" data-editable="true">${displayAge}</p></div>
                    
                    <div class="profile-item"><label>Gender</label><p>${displayGender}</p></div>
                    <div class="profile-item" style="grid-column:1/-1"><label>Address</label><p data-field="address" data-editable="false">${displayAddress}</p></div>
                </div>
            </div>
            <div class="profile-group">
                <h3>Family Details</h3>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                    <div class="profile-item"><label>Father's Name</label><p data-field="father_name" data-editable="false">${displayFather}</p></div>
                    <div class="profile-item"><label>Mother's Name</label><p data-field="mother_name" data-editable="false">${displayMother}</p></div>
                    <div class="profile-item" style="grid-column:1/-1"><label>Parent Mobile</label><p data-field="parent_mobile_number" data-editable="true">${displayParentMobile}</p></div>
                </div>
            </div>
            <div class="profile-group" style="border:none;">
                <h3>Academic Info</h3>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
                    <div class="profile-item"><label>Course</label><p>${displayCourse}</p></div>
                    <div class="profile-item"><label>Grad Year</label><p>${displayYear}</p></div>
                    
                </div>
            </div>
        `;
        document.getElementById('profile-details').innerHTML = profileHTML;

        // Fees Status
        const feesDue = (s.fees_due || "no").toLowerCase();
        const isPaid = feesDue === 'no' || feesDue === 'paid';
        const feeColor = isPaid ? 'var(--risk-low)' : 'var(--risk-high)';
        const feeText = isPaid ? 'Paid' : 'Due';
        
        document.getElementById('fees-status-container').innerHTML = `<span style="color:${feeColor}; font-weight:bold;">${feeText}</span>`;

        // Risk & Chatbot (USING API)
        fetchForumPosts().then(async (posts) => {
            const myPosts = posts.filter(p => p.studentId === uid);
            const sentiment = riskEngine.analyzeSentiment(myPosts);
            
            // Call Python API for score
            const apiResult = await fetchRiskAssessment(s, sentiment);
            
            const botTab = document.getElementById('chatbot-tab-btn');
            if (apiResult.risk_score >= 70) {
                botTab.style.display = 'none'; // Hide chat for high risk
            } else {
                botTab.style.display = 'block';
                setupChatbot(s);
            }
        });
    });
    
    setupForum();
}

// ==========================================
// 5. COUNSELOR DASHBOARD LOGIC
// ==========================================
function setupCounselorDashboard() {
    const rootRef = ref(db, '/');
    
    onValue(rootRef, async (snapshot) => {
        const students = [];
        const data = snapshot.val();
        const posts = await fetchForumPosts();
        
        if (data) {
            Object.keys(data).forEach(key => {
                // Filter out system nodes
                if (key === 'forum' || key === 'counselors' || key === 'chats' || key === 'sys') return;

                // HANDLE ARRAY DATA SAFELY (Skip nulls if keys are 0, 1, 2...)
                const record = data[key];
                if (!record) return; 

                const s = { id: key, ...record };
                
                // Only process if it looks like a student object (has a name)
                if (!s.name) return;
                
                // Calculate Preliminary Score for Sorting (Optimization: Don't call API for 50+ students at once)
                // Deep dive will fetch the real API score.
                const sPosts = posts.filter(p => p.studentId === s.id);
                
                let heuristic = 0;
                // Basic heuristic for initial sorting
                if((s.gpa || 0) < 5) heuristic += 10;
                if((s.attendance_percentage || 0) < 75) heuristic += 10;
                
                s.riskScore = heuristic; // Temporary placeholder for sort
                students.push(s);
            });
        }

        students.sort((a, b) => b.riskScore - a.riskScore);
        AppState.students = students;
        
        const listEl = document.getElementById('students-list');
        if(listEl) {
            listEl.innerHTML = '';
            
            students.forEach(s => {
                // We display a generic badge until they click deep dive
                const card = document.createElement('div');
                card.className = `student-card med`; // Default styling
                card.onclick = () => loadDeepDive(s);
                card.innerHTML = `
                    <div>
                        <div style="font-weight:600; font-size:1.1rem;">${s.name}</div>
                        <div style="font-size:0.8rem; color:var(--text-secondary);">${s.course_enrollment || 'N/A'}</div>
                    </div>
                    <div class="risk-badge med">View Analysis</div>
                `;
                listEl.appendChild(card);
            });
        }
    });
}

async function loadDeepDive(s) {
    document.getElementById('deep-dive-placeholder').classList.add('hidden');
    document.getElementById('deep-dive-content').classList.remove('hidden');
    AppState.selectedStudentId = s.id;

    document.getElementById('student-detail-title').textContent = s.name;
    document.getElementById('risk-badge-large').textContent = `Analyzing...`;
    
    document.getElementById('counselor-view-profile').innerHTML = `
        <div><b>Email:</b> ${s.emailid || 'N/A'}</div>
        <div><b>Mobile:</b> ${s.mobileno || 'N/A'}</div>
        <div><b>Course:</b> ${s.course_enrollment || 'N/A'}</div>
        <div><b>Batch:</b> ${s.year_of_graduation || 'N/A'}</div>
        <div><b>Parent:</b> ${s.father_name || 'N/A'}</div>
        <div><b>Parent Mob:</b> ${s.parent_mobile_number || 'N/A'}</div>
        <div><b>Fees Due:</b> ${s.fees_due || 'No'}</div>
        <div><b>Failures:</b> ${s.past_failures || 0}</div>
    `;

    // Fetch Real Data from Python API
    const posts = await fetchForumPosts();
    const studentPosts = posts.filter(p => p.studentId === s.id);
    const sentiment = riskEngine.analyzeSentiment(studentPosts);

    const apiData = await fetchRiskAssessment(s, sentiment);
    
    // Update Risk Badge
    const score = apiData.risk_score;
    document.getElementById('risk-badge-large').textContent = `Risk Score: ${score}`;
    
    // Render LIME Explanations from API
    const factors = apiData.explanation || [];
    
    if(factors.length === 0) {
        document.getElementById('lime-explanation').innerHTML = "<p>No significant risk factors detected.</p>";
    } else {
        document.getElementById('lime-explanation').innerHTML = factors.map(f => `
            <div class="xai-factor">
                <div style="display:flex; justify-content:space-between;">
                    <label>${f.name} <small>(${f.condition})</small></label>
                    <span style="color:${f.impact === '+Risk' ? 'var(--risk-high)' : 'var(--risk-low)'}">${f.impact}</span>
                </div>
                <div class="progress-bar">
                    <div style="width:${Math.abs(f.weight) * 100}%; background:${f.impact === '+Risk' ? 'var(--risk-high)' : 'var(--risk-low)'}"></div>
                </div>
            </div>
        `).join('');
    }

    // === NEW EMAIL BUTTONS AND LOGIC ===
    const existingButtons = document.getElementById('email-actions');
    if (existingButtons) existingButtons.remove();

    const actionDiv = document.createElement('div');
    actionDiv.id = 'email-actions';
    actionDiv.style = "display: flex; gap: 10px; margin-top: 20px;";
    
    // We attach onclick handlers that call our new window.handleEmailAction function
    actionDiv.innerHTML = `
        <button class="portal-btn" style="flex: 1; height: auto; padding: 10px;" 
            onclick="window.handleEmailAction('alert', '${s.emailid}', '${s.name}')">
            📧 Send Risk Alert
        </button>
        
        <button class="portal-btn" style="flex: 1; height: auto; padding: 10px; border-color: var(--accent-secondary); background-color: var(--accent-secondary);" 
            onclick="window.handleEmailAction('meeting', '${s.emailid}', '${s.name}')">
            📅 Schedule Meeting
        </button>
    `;
    document.getElementById('deep-dive-content').appendChild(actionDiv);
}

// === NEW EMAIL HANDLER FUNCTION ===
window.handleEmailAction = async (type, email, name) => {
    if (!email || email === 'N/A' || email === 'undefined') {
        alert("❌ Error: Student email is missing or invalid.");
        return;
    }

    let subject = "";
    let message = "";

    // LOGIC FOR ALERT VS MEETING
    if (type === 'alert') {
        subject = "⚠️ Critical Alert: Risk Score Increasing";
        message = `Dear ${name},\n\nWe have noticed that your Risk Score is increasing. You need to work on your attendance and grades immediately, otherwise, the risk will increase further and may lead to detainment.\n\nPlease visit the counselor's office if you need help.\n\n- Sentinel System`;
    
    } else if (type === 'meeting') {
        // Ask Counselor for Date and Time
        const meetingTime = prompt("Enter Meeting Date & Time (e.g., Monday 10:00 AM):");
        if (!meetingTime) return; // Cancel if empty

        subject = "📅 Counseling Meeting Scheduled";
        message = `Dear ${name},\n\nA mandatory counseling meeting has been scheduled for you.\n\nTime: ${meetingTime}\n\nPlease be present at the counselor's office on time.\n\n- Sentinel System`;
    }

    // UI Feedback
    const btn = event.target;
    const originalText = btn.innerText;
    btn.innerText = "Sending...";
    btn.disabled = true;

    try {
        const response = await fetch('http://localhost:5000/send_email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                student_email: email,
                subject: subject,
                message: message
            })
        });

        if (response.ok) {
            alert(`✅ Email sent successfully to ${email}`);
            document.getElementById('action-message').textContent = `${type === 'alert' ? 'Alert' : 'Meeting'} email sent to ${name}.`;
            document.getElementById('action-modal').classList.remove('hidden');
        } else {
            throw new Error("Backend failed to send email. Check server logs.");
        }
    } catch (error) {
        console.error(error);
        alert("❌ Failed to send email. Is the Python server running?");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
};

// ==========================================
// 6. UTILS & SHARED LOGIC
// ==========================================
window.toggleProfileEdit = async (btn) => {
    const container = document.getElementById('profile-details');
    const editableFields = container.querySelectorAll('[data-editable="true"]');
    
    if (btn.textContent.includes('Edit')) {
        btn.textContent = '💾 Save Changes';
        editableFields.forEach(el => {
            const input = document.createElement('input');
            input.value = el.textContent;
            input.dataset.field = el.dataset.field;
            input.dataset.editable = "true"; 
            el.replaceWith(input);
        });
    } else {
        btn.textContent = 'Saving...';
        btn.disabled = true;
        
        const updates = {};
        const inputs = container.querySelectorAll('input');
        inputs.forEach(input => {
            updates[input.dataset.field] = input.value;
        });

        try {
            const userRef = ref(db, AppState.activeUser.uid);
            await update(userRef, updates);
            
            inputs.forEach(input => {
                const p = document.createElement('p');
                p.dataset.field = input.dataset.field;
                p.dataset.editable = "true";
                p.textContent = input.value;
                input.replaceWith(p);
            });
        } catch (e) {
            console.error("Save failed", e);
            alert("Update failed.");
        } finally {
            btn.textContent = '✏️ Edit Profile';
            btn.disabled = false;
        }
    }
};

async function fetchForumPosts() {
    const dbRef = ref(db);
    const snapshot = await get(child(dbRef, `forum`));
    if (snapshot.exists()) {
        const data = snapshot.val();
        return Object.keys(data).map(key => ({ id: key, ...data[key] }));
    }
    return [];
}

function setupForum() {
    const list = document.getElementById('forum-posts-container');
    const forumRef = ref(db, 'forum');
    
    onValue(forumRef, (snapshot) => {
        if (!list) return;
        list.innerHTML = '';
        const data = snapshot.val();
        if (!data) return;
        
        const posts = Object.keys(data).map(key => ({ id: key, ...data[key] }));
        posts.sort((a,b) => (b.timestamp || 0) - (a.timestamp || 0));
        
        posts.forEach(p => {
            const div = document.createElement('div');
            div.className = 'forum-post';
            div.innerHTML = `
                <div style="color:var(--accent-secondary); font-size:0.8rem; margin-bottom:5px;">${p.author || 'Anonymous'}</div>
                <div>${p.content}</div>
            `;
            list.appendChild(div);
        });
    });

    const postForm = document.getElementById('new-post-form');
    if (postForm) {
        postForm.onsubmit = async (e) => {
            e.preventDefault();
            const content = document.getElementById('new-post-content').value;
            if(!content) return;
            
            const currentUserData = AppState.students[AppState.activeUser.uid];
            const authorName = currentUserData ? currentUserData.name : 'Student';
            
            const newPostRef = push(ref(db, 'forum'));
            await set(newPostRef, {
                content,
                author: authorName,
                studentId: AppState.activeUser.uid,
                timestamp: Date.now()
            });
            document.getElementById('new-post-content').value = '';
        };
    }
}

// Enrollment logic
const enrollForm = document.getElementById('enroll-form');
if (enrollForm) {
    enrollForm.onsubmit = async (e) => {
        e.preventDefault();
        const data = {
            name: document.getElementById('enroll-name').value,
            emailid: document.getElementById('enroll-email').value,
            mobileno: document.getElementById('enroll-mobile').value,
            age: parseInt(document.getElementById('enroll-age').value),
            gender: document.getElementById('enroll-gender').value,
            course_enrollment: document.getElementById('enroll-course').value,
            year_of_graduation: parseInt(document.getElementById('enroll-year').value),
            gpa: parseFloat(document.getElementById('enroll-gpa').value),
            father_name: document.getElementById('enroll-father').value,
            mother_name: document.getElementById('enroll-mother').value,
            parent_mobile_number: document.getElementById('enroll-parent-mob').value,
            address: document.getElementById('enroll-address').value,
            student_id: 'STU_' + new Date().getFullYear() + '_' + Math.floor(Math.random() * 1000),
            fees_due: 'Yes',
            attendance_percentage: 0,
            past_failures: 0
        };
        
        try {
            const newStudentRef = push(ref(db, '/'));
            await set(newStudentRef, data);
            window.closeModal('enroll-modal');
            alert("Student enrolled! They can now sign up.");
            enrollForm.reset();
        } catch (e) {
            console.error(e);
            alert("Enrollment failed");
        }
    };
}

// ==========================================
// CHATBOT SETUP (CONNECTED TO GROQ)
// ==========================================
async function setupChatbot(student) {
    const form = document.getElementById('chat-input-form');
    if (!form) return;
    
    // Clone to remove old event listeners to prevent duplicates
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);
    
    const newInput = document.getElementById('chat-input');
    const newBtn = document.getElementById('chat-send-btn');

    newForm.onsubmit = async (e) => {
        e.preventDefault();
        const text = newInput.value.trim();
        if(!text) return;

        // 1. Add User Message
        addChatBubble(text, 'user');
        
        // 2. Clear Input & Show Loading
        newInput.value = '';
        newBtn.disabled = true;
        addChatBubble('Thinking...', 'bot', true);

        try {
            // 3. Send to Python Backend (which calls Groq)
            // Make sure your app.py is running on port 5000
            const res = await fetch('http://localhost:5000/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    prompt: text, 
                    student: student // Sends context (Name, GPA, etc.)
                })
            });

            const data = await res.json();

            // 4. Remove Typing Indicator
            document.querySelector('.typing-indicator')?.remove();

            // 5. Display AI Response
            if (data.error) {
                addChatBubble("System Error: " + data.error, 'bot');
            } else {
                addChatBubble(data.generated_text || "I couldn't process that.", 'bot');
            }

        } catch (err) {
            document.querySelector('.typing-indicator')?.remove();
            console.error(err);
            addChatBubble("Error: Could not connect to the Sentinel Python server.", 'bot');
        } finally {
            newBtn.disabled = false;
            newInput.focus();
        }
    };
}

function addChatBubble(text, sender, isTyping=false) {
    const div = document.createElement('div');
    div.className = `chat-message ${sender}-message ${isTyping ? 'typing-indicator' : ''}`;
    div.textContent = text;
    const container = document.getElementById('chat-messages');
    if (container) {
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }
}

window.openEnrollModal = () => document.getElementById('enroll-modal').classList.remove('hidden');
window.closeModal = (id) => document.getElementById(id).classList.add('hidden');
window.switchTab = (tab) => {
    document.querySelectorAll('.content-panel').forEach(p => p.classList.remove('active'));
    const targetPanel = document.getElementById(`${tab}-panel`);
    if (targetPanel) targetPanel.classList.add('active');
    
    document.querySelectorAll('.nav-menu button').forEach(b => b.classList.remove('active'));
    if(event && event.target) event.target.classList.add('active');
};

window.handleCounselorAction = (action) => {
    document.getElementById('action-message').textContent = `Action "${action}" executed successfully.`;
    document.getElementById('action-modal').classList.remove('hidden');
};

window.startStudentScanner = () => {
    document.getElementById('student-reader').classList.remove('hidden');
    document.getElementById('stop-scan-btn').classList.remove('hidden');
    const scanner = new Html5Qrcode("student-reader");
    AppState.html5QrCode = scanner;
    scanner.start({ facingMode: "environment" }, { fps: 10, qrbox: 250 }, (decodedText) => {
        alert("Attendance Marked: " + decodedText);
        scanner.stop();
        document.getElementById('student-reader').classList.add('hidden');
        document.getElementById('stop-scan-btn').classList.add('hidden');
    });
};