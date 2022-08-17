# Docker

If you want to avoid all the hassle of installing the dependencies, configuring nginx and so on you can try our docker image which makes things a bit simpler.

First make sure you have docker and docker composer installed, so please follow the install instructions for your OS/Distro:
- https://docs.docker.com/engine/install/debian/
- https://docs.docker.com/compose/install/

After that:
- Navigate to this directory (`docker`).
- Copy the config file called `docker-compose.config.example.yml` and name it `docker-compose.config.yml` with the values you want. Those that are left commented will use the default values.
- Navigate to `nginx` directory, then copy either `chensafe.tld.http.example.conf` or `chensafe.tld.https.example.conf` and name it `chensafe.tld.conf` for either HTTP or HTTPS.  
  If using HTTPS make sure to put your certificates into the `ssl` folder and name them accordingly:
  - `chensafe.tld.crt` for the certificate
  - `chensafe.tld.key` for the certificate key

Once you are done run the following commands:

- `./chensafe.sh prod pull`
- `./chensafe.sh prod build`
- `./chensafe.sh prod up -d`

If you are on a Windows host, replace `./chensafe.sh` with `./chensafe.ps1`.

Congrats, your chensafe instance is now running.
