import pandas as pd
import numpy as np
import xgboost as xgb
import lime
import lime.lime_tabular
import firebase_admin
from firebase_admin import credentials, db
from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import requests
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

app = Flask(__name__)
CORS(app)

# ==========================================
# 1. CONFIGURATION
# ==========================================
# --- GROQ API CONFIGURATION ---
# UPDATED: Using the model from your image
GROQ_API_KEY = "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" 
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.3-70b-versatile" 

# --- EMAIL CONFIGURATION ---
# ⚠️ Ensure you generate a specific 'App Password' for Gmail if 2FA is on.
SENDER_EMAIL = "deepakkumar201120@gmail.com" 
SENDER_PASSWORD = "cdfm nrdo dmwv atou" 

# ==========================================
# 2. FIREBASE SETUP
# ==========================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
cred_path = os.path.join(BASE_DIR, "serviceAccountKey.json")
database_url = "https://ai-dropout-system-default-rtdb.firebaseio.com/"

if os.path.exists(cred_path):
    if not firebase_admin._apps:
        cred = credentials.Certificate(cred_path)
        firebase_admin.initialize_app(cred, {
            'databaseURL': database_url
        })
        print(f"✅ Firebase Admin Connected: {cred_path}")
    else:
         print("✅ Firebase already initialized.")
else:
    print(f"❌ ERROR: 'serviceAccountKey.json' NOT FOUND at {cred_path}")

# Global variables
model = None
explainer = None
feature_columns = ['attendance_percentage', 'gpa', 'past_failures', 'fees_due_binary', 'sentiment_score']

# ==========================================
# 3. DATA PROCESSING & TRAINING
# ==========================================
def fetch_and_train_model():
    print("Fetching student data from Firebase...")
    
    student_records = []

    try:
        ref = db.reference('/')
        data = ref.get()
        
        if not data:
            print("❌ Database returned empty data.")
            return None, None

        raw_items = []
        if isinstance(data, list):
            raw_items = [x for x in data if x is not None]
        elif isinstance(data, dict):
            for key, val in data.items():
                if key not in ['forum', 'counselors', 'chats', 'sys']:
                    raw_items.append(val)

        print(f"Processing {len(raw_items)} records...")
        
        for val in raw_items:
            if not isinstance(val, dict) or ('name' not in val and 'emailid' not in val):
                continue

            fees_str = str(val.get('fees_due', 'No')).lower()
            fees_binary = 1 if fees_str in ['yes', 'due', 'unpaid'] else 0
            
            try:
                gpa_val = float(val.get('gpa', 0))
            except:
                gpa_val = 0.0

            try:
                fails = int(val.get('past_failures', 0))
            except:
                fails = 0

            record = {
                'attendance_percentage': float(val.get('attendance_percentage', 0)),
                'gpa': gpa_val,
                'past_failures': fails,
                'fees_due_binary': fees_binary,
                'sentiment_score': 0.0
            }
            student_records.append(record)

        if len(student_records) < 5:
            print(f"⚠️ Found only {len(student_records)} valid records. Training might be inaccurate.")
        
        df = pd.DataFrame(student_records)
        df = df[feature_columns]

        # --- REALISTIC RISK CALCULATION (0-100) ---
        df['gpa_risk'] = (10.0 - df['gpa']) * 5.5
        df['fees_risk'] = df['fees_due_binary'] * 30.0
        df['fail_risk'] = df['past_failures'].clip(upper=2) * 10.0
        df['att_risk'] = (100.0 - df['attendance_percentage']) * 0.15

        df['risk_target'] = df['gpa_risk'] + df['fees_risk'] + df['fail_risk'] + df['att_risk']
        df['risk_target'] = np.clip(df['risk_target'], 0, 100)

        X = df[feature_columns]
        y = df['risk_target']
        
        new_model = xgb.XGBRegressor(objective='reg:squarederror', n_estimators=100)
        new_model.fit(X, y)
        
        new_explainer = lime.lime_tabular.LimeTabularExplainer(
            X.values, 
            feature_names=feature_columns, 
            class_names=['risk_score'], 
            mode='regression'
        )
        
        print(f"✅ Model Retrained. Average Risk Score: {y.mean():.2f}")
        return new_model, new_explainer

    except Exception as e:
        print(f"❌ Training Failed: {e}")
        import traceback
        traceback.print_exc()
        return None, None

# Initial Training
model, explainer = fetch_and_train_model()

# ==========================================
# 4. API ENDPOINTS
# ==========================================

@app.route('/predict_risk', methods=['POST'])
def predict_risk():
    global model, explainer
    
    if model is None:
        model, explainer = fetch_and_train_model()
        if model is None:
            return jsonify({'error': 'Model failed to train.'}), 500

    try:
        data = request.json
        fees_str = str(data.get('fees_due', '')).lower()
        fees_binary = 1 if fees_str in ['yes', 'due', 'unpaid'] else 0
        
        features = pd.DataFrame([{
            'attendance_percentage': float(data.get('attendance_percentage', 0)),
            'gpa': float(data.get('gpa', 0)),
            'past_failures': int(data.get('past_failures', 0)),
            'fees_due_binary': fees_binary,
            'sentiment_score': float(data.get('sentiment_score', 0))
        }])
        
        features = features[feature_columns]

        prediction = model.predict(features)[0]
        risk_score = float(np.clip(prediction, 0, 100))

        exp = explainer.explain_instance(features.values[0], model.predict, num_features=5)
        lime_factors = []
        current_student_vals = features.iloc[0]

        for feature_condition, weight in exp.as_list():
            clean_name = ""
            actual_value_display = ""

            if 'attendance' in feature_condition: 
                clean_name = "Attendance"
                actual_value_display = f"{current_student_vals['attendance_percentage']:.1f}%"
            elif 'gpa' in feature_condition: 
                clean_name = "GPA"
                actual_value_display = f"{current_student_vals['gpa']:.2f}"
            elif 'failures' in feature_condition: 
                clean_name = "Failures"
                actual_value_display = f"{int(current_student_vals['past_failures'])}"
            elif 'fees' in feature_condition: 
                clean_name = "Fees Status"
                actual_value_display = "Due" if current_student_vals['fees_due_binary'] == 1 else "Paid"
            elif 'sentiment' in feature_condition: 
                clean_name = "Forum Sentiment"
                actual_value_display = f"{current_student_vals['sentiment_score']:.1f}"
            else:
                clean_name = feature_condition.split(' ')[0]

            impact_type = '+Risk' if weight > 0 else 'Safe'
            
            lime_factors.append({
                'name': clean_name,
                'condition': actual_value_display,
                'weight': weight,
                'impact': impact_type
            })

        return jsonify({
            'risk_score': int(risk_score),
            'explanation': lime_factors
        })

    except Exception as e:
        print("Prediction Error:", e)
        return jsonify({'error': str(e)}), 500

# --- EMAIL ENDPOINT ---
@app.route('/send_email', methods=['POST'])
def send_email_route():
    try:
        data = request.json
        student_email = data.get('student_email')
        subject = data.get('subject')
        message_body = data.get('message')

        if not student_email:
            return jsonify({'error': 'Student email is missing'}), 400

        # Setup Email
        msg = MIMEMultipart()
        msg['From'] = SENDER_EMAIL
        msg['To'] = student_email
        msg['Subject'] = subject

        msg.attach(MIMEText(message_body, 'plain'))

        # Connect to Gmail Server
        server = smtplib.SMTP('smtp.gmail.com', 587)
        server.starttls()
        server.login(SENDER_EMAIL, SENDER_PASSWORD)
        text = msg.as_string()
        server.sendmail(SENDER_EMAIL, student_email, text)
        server.quit()

        print(f"✅ Email sent to {student_email}")
        return jsonify({'status': 'success'})

    except Exception as e:
        print(f"❌ Email Failed: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/retrain', methods=['POST'])
def trigger_retrain():
    global model, explainer
    model, explainer = fetch_and_train_model()
    return jsonify({'status': 'Retraining complete' if model else 'Failed'})

# --- UPDATED CHAT ENDPOINT (GROQ) ---
@app.route('/chat', methods=['POST'])
def chat_with_ai():
    try:
        data = request.get_json()
        user_prompt = data.get('prompt')
        student_context = data.get('student', {})

        if not user_prompt:
            return jsonify({"error": "Prompt is missing"}), 400

        student_name = student_context.get('name', 'Student')
        gpa_val = student_context.get('gpa', 0)
        
        system_prompt = (
            f"You are Sentinel Assistant. The student is {student_name}, GPA: {gpa_val}. "
            f"Keep response under 50 words. Be helpful and encouraging."
        )

        # GROQ API Payload
        headers = {
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json"
        }
        
        payload = {
            "model": GROQ_MODEL,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "stream": False
        }

        response = requests.post(GROQ_API_URL, headers=headers, json=payload)
        response.raise_for_status()
        
        response_data = response.json()
        # Groq returns standard OpenAI format
        generated_text = response_data['choices'][0]['message']['content']
        
        return jsonify({"generated_text": generated_text})

    except Exception as e:
        print(f"Groq API Error: {e}")
        return jsonify({"error": "AI service unavailable"}), 500

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=True)