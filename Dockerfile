FROM node:18-alpine
LABEL maintainer "siggame@mst.edu"

RUN apk add --no-cache git

ADD . cerveau
WORKDIR cerveau

RUN npm install

EXPOSE 3000
EXPOSE 3080

CMD ["node", "--max-old-space-size=512", "./main.js"]
