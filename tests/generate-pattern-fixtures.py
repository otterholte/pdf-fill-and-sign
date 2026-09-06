from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import json
root=Path('tests/fixtures');W,H=1103,1426
# Regeneration only: prefer Arial on Windows, Liberation Sans on Linux.
font_dir=Path('C:/Windows/Fonts')
regular=str(font_dir/'arial.ttf') if font_dir.exists() else '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf'
bold=str(font_dir/'arialbd.ttf') if font_dir.exists() else '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf'
fields=[]
def add(label,rect,value='Alex Example',kind='text',parts=None):
 d=dict(label=label,rect=rect,value=value,kind=kind)
 if parts:d['parts']=parts
 if parts and ('date' in label.lower() or 'birth' in label.lower()):d['tokens']=['MM','DD','YYYY'] if 'birth' in label.lower() else order
 fields.append(d)
add('Full Name',[292,232,1042,251])
add('Date of Birth',[292,274,679,308],'03/14/1990',parts=[[292,274,390,308],[432,274,513,308],[556,274,679,308]])
add('Phone Number',[300,365,711,385],'212-555-0100',parts=[[300,365,382,385],[409,365,486,385],[519,365,711,385]])
add('Social Security',[292,415,597,435],'000-12-3456',parts=[[292,415,375,435],[410,415,469,435],[503,415,597,435]])
add('Email Address',[292,469,1042,489],'alex@example.com')
add('Street Address',[292,522,1042,542],'123 Example Lane')
add('City, State',[292,579,1042,599],'Example City, CO 80000')
add('Employee ID',[292,621,609,664],'AB1234',parts=[[x,621,x+53,664] for x in [292,345,398,451,504,557]])
for label,x in [('New Applicant',293),('Returning',489),('Verified',649),('Requires Follow-Up',789)]:add(label,[x,699,x+27,726],kind='box')
add('legally authorized',[534,770,701,798],kind='radio')
add('Comments',[62,869,1042,1022],'Sample notes.\nSecond line of notes.')
add('Signature',[230,1083,751,1103],kind='signature')
add('^Date$',[851,1083,1042,1103],'09/06/2026')
add('Printed Name',[230,1149,751,1169])
add('Initials',[871,1149,1042,1169],'AE')
add('Reviewed By',[62,1276,383,1331])
add('Date Reviewed',[383,1276,713,1331],'09/06/2026')
add('Reference No',[713,1276,1042,1331],'REF-0123')
(root/'mixed-layout-truth.json').write_text(json.dumps(dict(width=W,height=H,fields=fields),indent=2))
# Independently generated arrangements: varied wording, gaps, sizes, and date order.
for i,(title,name,code,notes,order) in enumerate([
 ('Community Volunteer Intake','Contact name','Reference code','Details',['MM','DD','YYYY']),
 ('Equipment Service Request','Customer name','Account ID','Comments',['YYYY','MM','DD']),
 ('Workshop Registration','Attendee name','Registration code','Additional notes',['DD','MM','YYYY'])]):
 W,H=1000,1300;im=Image.new('RGB',(W,H),'white');d=ImageDraw.Draw(im);font=ImageFont.truetype(regular,22);head=ImageFont.truetype(bold,29);small=ImageFont.truetype(regular,17);fields=[]
 d.text((60,55),title,font=head,fill='black');d.line((60,110,940,110),fill='black',width=2)
 x=340+i*25;d.text((60,167),name+':',font=font,fill='black');d.line((x,195,930,195),fill='black',width=2);add(name,[x,172,930,195])
 d.text((60,252),'Start date:',font=font,fill='black');parts=[];xx=x
 for token in order:
  ww=115 if token=='YYYY' else 78;d.rectangle((xx,245,xx+ww,285),outline='black',width=2);d.text((xx+ww/2,300),token,font=small,fill='black',anchor='mt');parts.append([xx,245,xx+ww,285]);xx+=ww+33
 add('Start date',[x,245,xx-33,285],'/'.join('2026' if t=='YYYY' else '09' if t=='MM' else '14' for t in order),parts=parts)
 d.text((60,389),code+':',font=font,fill='black');n=4+i*2;ww=42+i*3;parts=[]
 for k in range(n):d.rectangle((x+k*ww,380,x+(k+1)*ww,425),outline='black',width=2);parts.append([x+k*ww,380,x+(k+1)*ww,425])
 add(code,[x,380,x+n*ww,425],('AB123456')[:n],parts=parts)
 d.text((60,490),notes+':',font=font,fill='black');d.rectangle((60,525,920-i*40,685+i*15),outline='black',width=2);add(notes,[60,525,920-i*40,685+i*15],'Sample details.\nAnother line.')
 for name2,xx in [('Option A',250),('Option B',520)]:d.rectangle((xx,770,xx+26,796),outline='black',width=2);d.text((xx+42,770),name2,font=font,fill='black');add(name2,[xx,770,xx+26,796],kind='box')
 for lab,l,r in [('Processed by',60,510),('Reference',510,940)]:d.rectangle((l,900,r,1000),outline='black',width=2);d.text((l+10,910),lab+':',font=font,fill='black');add(lab,[l,941,r,1000])
 d.text((60,1118),'Signature:',font=font,fill='black');d.line((250,1150,670,1150),fill='black',width=2);add('Signature',[250,1125,670,1150],kind='signature')
 d.text((715,1118),'Date:',font=font,fill='black');d.line((785,1150,940,1150),fill='black',width=2);add('^Date$',[785,1125,940,1150],'09/06/2026')
 stem=f'varied-layout-{i+1}';im.save(root/(stem+'-blank.png'));(root/(stem+'-truth.json')).write_text(json.dumps(dict(width=W,height=H,fields=fields),indent=2))
