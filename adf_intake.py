"""Convert a supported dealer ADF/XML export to intake JSON; no email account connection assumed.
Usage: python adf_intake.py lead.xml CarGurus
Submit emitted JSON to /api/intake from your authenticated mail delivery bridge.
Consent is deliberately absent: a phone number alone is not SMS opt-in evidence.
"""
import sys,json,hashlib,xml.etree.ElementTree as ET
raw=open(sys.argv[1],'rb').read()
if len(raw)>128000 or b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
    raise ValueError('Unsafe or oversized XML')
source=sys.argv[2]
if source not in ('CarGurus','AutoTrader'): raise ValueError('Unsupported source')
r=ET.fromstring(raw)
def text(path):
    el=r.find('.//'+path)
    return (el.text or '').strip() if el is not None else ''
p={'source':source,'externalId':text('prospect/id') or hashlib.sha256(raw).hexdigest(),'name':' '.join(n.text.strip() for n in r.findall('.//customer/contact/name') if n.text) or 'Dealer inquiry','phone':text('customer/contact/phone'),'body':text('customer/comments'),'vehicleId':text('vehicle/stock'),'consent':None}
phone=''.join(c for c in p['phone'] if c.isdigit())
if len(phone)==10: p['phone']='+1'+phone
elif len(phone)==11 and phone.startswith('1'): p['phone']='+'+phone
elif p['phone'] and not p['phone'].startswith('+'): raise ValueError('Phone needs country code')
print(json.dumps(p))
